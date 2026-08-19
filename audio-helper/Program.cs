using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("Audio helper is Windows-only.");
    return 2;
}

if (args.Length == 0 || args[0] is not ("list" or "mute" or "stream-exclude" or "stream-include" or "capabilities"))
{
    Console.Error.WriteLine("Usage: AudioHelper list | capabilities | mute <pid> <true|false> | stream-exclude <pid> | stream-include <pid>");
    return 2;
}

try
{
    if (args[0] == "list")
    {
        var sessions = AudioSessions.List()
            .GroupBy(session => session.ProcessId)
            .Select(group =>
            {
                var first = group.First();
                return new AudioApp(
                    first.ProcessId,
                    first.ProcessName,
                    first.WindowTitle,
                    first.Muted || group.All(session => session.Muted),
                    group.Max(session => session.Volume)
                );
            })
            .OrderBy(app => app.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        Console.WriteLine(JsonSerializer.Serialize(sessions));
        return 0;
    }

    if (args[0] == "capabilities")
    {
        Console.WriteLine(JsonSerializer.Serialize(WindowsAudioCapabilities.Current()));
        return 0;
    }

    if (args[0] is "stream-exclude" or "stream-include")
    {
        if (args.Length != 2 || !uint.TryParse(args[1], out var targetProcessId))
        {
            Console.Error.WriteLine($"Usage: AudioHelper {args[0]} <pid>");
            return 2;
        }

        ProcessLoopbackStreamer.Stream(targetProcessId, includeProcessTree: args[0] == "stream-include");
        return 0;
    }

    if (args.Length != 3 || !uint.TryParse(args[1], out var processId) || !bool.TryParse(args[2], out var muted))
    {
        Console.Error.WriteLine("Usage: AudioHelper mute <pid> <true|false>");
        return 2;
    }

    var changed = AudioSessions.SetMute(processId, muted);
    Console.WriteLine(JsonSerializer.Serialize(new { ok = true, changed }));
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

record AudioApp(uint ProcessId, string Name, string WindowTitle, bool Muted, float Volume);

record AudioSession(uint ProcessId, string ProcessName, string WindowTitle, bool Muted, float Volume);

record AudioCapabilityInfo(
    bool ProcessLoopbackSupported,
    string OsDescription,
    string WindowsVersion,
    int CurrentBuild,
    int MinimumProcessLoopbackBuild,
    string Message
);

static class WindowsAudioCapabilities
{
    public const int MinimumProcessLoopbackBuild = 20348;

    public static AudioCapabilityInfo Current()
    {
        var version = Environment.OSVersion.Version;
        var supported = ProcessLoopbackSupported();
        var message = supported
            ? "Captura de audio por processo disponivel."
            : $"Captura de audio por processo requer Windows 10 build {MinimumProcessLoopbackBuild} ou superior. No Windows 10 comum, use audio da guia ou transmita tela sem audio para nao vazar Discord.";

        return new AudioCapabilityInfo(
            supported,
            RuntimeInformation.OSDescription,
            version.ToString(),
            version.Build,
            MinimumProcessLoopbackBuild,
            message
        );
    }

    public static bool ProcessLoopbackSupported()
    {
        return OperatingSystem.IsWindowsVersionAtLeast(10, 0, MinimumProcessLoopbackBuild);
    }
}

static class ProcessLoopbackStreamer
{
    const string ProcessLoopbackDevice = "VAD\\Process_Loopback";
    static readonly Guid AudioClientGuid = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    static readonly Guid AudioCaptureClientGuid = new("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    public static void Stream(uint processId, bool includeProcessTree)
    {
        if (!WindowsAudioCapabilities.ProcessLoopbackSupported())
        {
            throw new PlatformNotSupportedException(WindowsAudioCapabilities.Current().Message);
        }

        var audioClient = Activate(processId, includeProcessTree);
        var format = WaveFormatExtensible.PcmStereo44100();
        var formatPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WaveFormatExtensible>());

        try
        {
            Marshal.StructureToPtr(format, formatPtr, false);

            const AudioClientStreamFlags flags =
                AudioClientStreamFlags.Loopback | AudioClientStreamFlags.AutoConvertPcm;

            Marshal.ThrowExceptionForHR(audioClient.Initialize(
                AudioClientShareMode.Shared,
                flags,
                1_000_000,
                0,
                formatPtr,
                IntPtr.Zero
            ));

            var captureClientGuid = AudioCaptureClientGuid;
            Marshal.ThrowExceptionForHR(audioClient.GetService(ref captureClientGuid, out var captureObject));
            var captureClient = (IAudioCaptureClient)captureObject;

            using var output = Console.OpenStandardOutput();
            audioClient.Start();

            try
            {
                while (true)
                {
                    Marshal.ThrowExceptionForHR(captureClient.GetNextPacketSize(out var packetFrames));
                    if (packetFrames == 0)
                    {
                        Thread.Sleep(5);
                        continue;
                    }

                    Marshal.ThrowExceptionForHR(captureClient.GetBuffer(
                        out var data,
                        out var frames,
                        out var bufferFlags,
                        out _,
                        out _
                    ));

                    var byteCount = checked((int)(frames * format.Format.nBlockAlign));
                    var buffer = new byte[byteCount];

                    if (!bufferFlags.HasFlag(AudioClientBufferFlags.Silent))
                    {
                        Marshal.Copy(data, buffer, 0, byteCount);
                    }

                    captureClient.ReleaseBuffer(frames);
                    output.Write(buffer, 0, buffer.Length);
                }
            }
            catch (IOException)
            {
                // Browser/server closed the stream.
            }
            finally
            {
                audioClient.Stop();
            }
        }
        finally
        {
            Marshal.FreeHGlobal(formatPtr);
        }
    }

    static IAudioClient Activate(uint processId, bool includeProcessTree)
    {
        var parameters = new ActivationParameters
        {
            ActivationType = ActivationType.ProcessLoopback,
            Process = new ProcessParameters
            {
                ProcessId = processId,
                Mode = includeProcessTree ? ProcessLoopbackMode.IncludeProcessTree : ProcessLoopbackMode.ExcludeProcessTree,
            },
        };

        var parametersPtr = IntPtr.Zero;
        var variantPtr = IntPtr.Zero;

        try
        {
            parametersPtr = Marshal.AllocHGlobal(Marshal.SizeOf<ActivationParameters>());
            Marshal.StructureToPtr(parameters, parametersPtr, false);

            var variant = new BlobVariant
            {
                Type = 65,
                Size = Marshal.SizeOf<ActivationParameters>(),
                Data = parametersPtr,
            };
            variantPtr = Marshal.AllocHGlobal(Marshal.SizeOf<BlobVariant>());
            Marshal.StructureToPtr(variant, variantPtr, false);

            var completion = new ActivationCompletion();
            var audioClientGuid = AudioClientGuid;
            Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync(
                ProcessLoopbackDevice,
                ref audioClientGuid,
                variantPtr,
                completion,
                out var operation
            ));

            if (!completion.Wait(TimeSpan.FromSeconds(5)))
            {
                throw new TimeoutException("Timeout ao abrir captura de audio filtrada.");
            }

            return completion.GetAudioClient();
        }
        finally
        {
            if (variantPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(variantPtr);
            }

            if (parametersPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(parametersPtr);
            }
        }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation
    );

    sealed class ActivationCompletion : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        readonly ManualResetEventSlim completed = new(false);
        int activationResult;
        IAudioClient? audioClient;
        Exception? error;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                var result = operation.GetActivateResult(out activationResult, out var activatedObject);
                if (result < 0)
                {
                    activationResult = result;
                }

                if (activationResult >= 0)
                {
                    audioClient = (IAudioClient)activatedObject;
                }
            }
            catch (Exception ex)
            {
                error = ex;
            }
            finally
            {
                completed.Set();
            }

            return 0;
        }

        public bool Wait(TimeSpan timeout) => completed.Wait(timeout);

        public IAudioClient GetAudioClient()
        {
            if (error is not null)
            {
                throw error;
            }

            Marshal.ThrowExceptionForHR(activationResult);
            return audioClient ?? throw new InvalidOperationException("Windows nao retornou IAudioClient.");
        }
    }
}

static class AudioSessions
{
    public static IReadOnlyList<AudioSession> List()
    {
        var result = new List<AudioSession>();

        foreach (var session in GetSessions())
        {
            var control2 = (IAudioSessionControl2)session;
            control2.GetProcessId(out var processId);
            if (processId == 0)
            {
                continue;
            }

            var volume = (ISimpleAudioVolume)session;
            volume.GetMute(out var muted);
            volume.GetMasterVolume(out var level);

            result.Add(new AudioSession(
                processId,
                GetProcessName(processId),
                GetWindowTitle(processId),
                muted,
                level
            ));
        }

        return result;
    }

    public static int SetMute(uint processId, bool muted)
    {
        var changed = 0;

        foreach (var session in GetSessions())
        {
            var control2 = (IAudioSessionControl2)session;
            control2.GetProcessId(out var sessionProcessId);
            if (sessionProcessId != processId)
            {
                continue;
            }

            var volume = (ISimpleAudioVolume)session;
            volume.SetMute(muted, Guid.Empty);
            changed += 1;
        }

        return changed;
    }

    static IEnumerable<IAudioSessionControl> GetSessions()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out var device));

        var managerId = typeof(IAudioSessionManager2).GUID;
        Marshal.ThrowExceptionForHR(device.Activate(ref managerId, CLSCTX.CLSCTX_ALL, IntPtr.Zero, out var managerObject));
        var manager = (IAudioSessionManager2)managerObject;

        Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out var sessionEnumerator));
        Marshal.ThrowExceptionForHR(sessionEnumerator.GetCount(out var count));

        for (var index = 0; index < count; index++)
        {
            Marshal.ThrowExceptionForHR(sessionEnumerator.GetSession(index, out var session));
            yield return session;
        }
    }

    static string GetProcessName(uint processId)
    {
        try
        {
            return Process.GetProcessById((int)processId).ProcessName + ".exe";
        }
        catch
        {
            return $"pid-{processId}";
        }
    }

    static string GetWindowTitle(uint processId)
    {
        try
        {
            return Process.GetProcessById((int)processId).MainWindowTitle;
        }
        catch
        {
            return "";
        }
    }
}

enum EDataFlow
{
    eRender,
    eCapture,
    eAll,
}

enum ERole
{
    eConsole,
    eMultimedia,
    eCommunications,
}

[Flags]
enum CLSCTX
{
    CLSCTX_INPROC_SERVER = 0x1,
    CLSCTX_INPROC_HANDLER = 0x2,
    CLSCTX_LOCAL_SERVER = 0x4,
    CLSCTX_REMOTE_SERVER = 0x10,
    CLSCTX_ALL = CLSCTX_INPROC_SERVER | CLSCTX_INPROC_HANDLER | CLSCTX_LOCAL_SERVER | CLSCTX_REMOTE_SERVER,
}

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator
{
}

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    int Activate(ref Guid iid, CLSCTX clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
    int OpenPropertyStore(uint access, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out uint state);
}

[ComImport]
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
    int GetAudioSessionControl(IntPtr audioSessionGuid, uint streamFlags, out IntPtr sessionControl);
    int GetSimpleAudioVolume(IntPtr audioSessionGuid, uint streamFlags, out IntPtr audioVolume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
    int RegisterSessionNotification(IntPtr sessionNotification);
    int UnregisterSessionNotification(IntPtr sessionNotification);
    int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
    int UnregisterDuckNotification(IntPtr duckNotification);
}

[ComImport]
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
    int GetCount(out int sessionCount);
    int GetSession(int sessionCount, out IAudioSessionControl session);
}

[ComImport]
[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl
{
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, Guid eventContext);
    int GetGroupingParam(out Guid groupingId);
    int SetGroupingParam(Guid groupingId, Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
}

[ComImport]
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, Guid eventContext);
    int GetGroupingParam(out Guid groupingId);
    int SetGroupingParam(Guid groupingId, Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
    int GetProcessId(out uint processId);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
}

[ComImport]
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume
{
    int SetMasterVolume(float level, Guid eventContext);
    int GetMasterVolume(out float level);
    int SetMute(bool isMuted, Guid eventContext);
    int GetMute(out bool isMuted);
}

enum ActivationType
{
    Default,
    ProcessLoopback,
}

enum ProcessLoopbackMode
{
    IncludeProcessTree,
    ExcludeProcessTree,
}

enum AudioClientShareMode
{
    Shared,
    Exclusive,
}

[Flags]
enum AudioClientStreamFlags : uint
{
    Loopback = 0x00020000,
    AutoConvertPcm = 0x80000000,
}

[Flags]
enum AudioClientBufferFlags : uint
{
    None = 0,
    DataDiscontinuity = 0x1,
    Silent = 0x2,
    TimestampError = 0x4,
}

[StructLayout(LayoutKind.Sequential)]
struct ActivationParameters
{
    public ActivationType ActivationType;
    public ProcessParameters Process;
}

[StructLayout(LayoutKind.Sequential)]
struct ProcessParameters
{
    public uint ProcessId;
    public ProcessLoopbackMode Mode;
}

[StructLayout(LayoutKind.Sequential)]
struct BlobVariant
{
    public ushort Type;
    public ushort Reserved1;
    public ushort Reserved2;
    public ushort Reserved3;
    public int Size;
    public IntPtr Data;
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
struct WaveFormatEx
{
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
}

[StructLayout(LayoutKind.Sequential)]
struct WaveFormatExtensible
{
    public WaveFormatEx Format;
    public ushort wValidBitsPerSample;
    public uint dwChannelMask;
    public Guid SubFormat;

    public static WaveFormatExtensible PcmStereo44100()
    {
        return new WaveFormatExtensible
        {
            Format = new WaveFormatEx
            {
                wFormatTag = 0xFFFE,
                nChannels = 2,
                nSamplesPerSec = 44_100,
                nAvgBytesPerSec = 44_100 * 2 * 2,
                nBlockAlign = 4,
                wBitsPerSample = 16,
                cbSize = 22,
            },
            wValidBitsPerSample = 16,
            dwChannelMask = 0x3,
            SubFormat = new Guid("00000001-0000-0010-8000-00AA00389B71"),
        };
    }
}

[ComImport]
[Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
    int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}

[ComImport]
[Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
    int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport]
[Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject
{
}

[ComImport]
[Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    int Initialize(
        AudioClientShareMode shareMode,
        AudioClientStreamFlags streamFlags,
        long bufferDuration,
        long periodicity,
        IntPtr format,
        IntPtr audioSessionGuid
    );

    int GetBufferSize(out uint bufferSize);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(AudioClientShareMode shareMode, IntPtr format, out IntPtr closestMatch);
    int GetMixFormat(out IntPtr deviceFormat);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr eventHandle);
    int GetService(ref Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport]
[Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    int GetBuffer(
        out IntPtr data,
        out uint framesToRead,
        out AudioClientBufferFlags bufferFlags,
        out ulong devicePosition,
        out ulong qpcPosition
    );

    int ReleaseBuffer(uint framesRead);
    int GetNextPacketSize(out uint nextPacketSize);
}
