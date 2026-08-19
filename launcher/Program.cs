using System.Diagnostics;

static string AppDir()
{
    return AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
}

static bool IsPythonReady(string fileName, string arguments)
{
    try
    {
        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        });

        process?.WaitForExit(3000);
        return process?.HasExited == true && process.ExitCode == 0;
    }
    catch
    {
        return false;
    }
}

static (string FileName, string ArgumentsPrefix)? FindPython()
{
    var envPython = Environment.GetEnvironmentVariable("JANJA_PYTHON");
    if (!string.IsNullOrWhiteSpace(envPython) && IsPythonReady(envPython, "--version"))
    {
        return (envPython, "");
    }

    var localPythonCandidates = new[]
    {
        Path.Combine(AppDir(), "runtime", "python", "python.exe"),
        Path.Combine(AppDir(), "python", "python.exe"),
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".cache",
            "codex-runtimes",
            "codex-primary-runtime",
            "dependencies",
            "python",
            "python.exe")
    };

    foreach (var candidate in localPythonCandidates)
    {
        if (File.Exists(candidate) && IsPythonReady(candidate, "--version"))
        {
            return (candidate, "");
        }
    }

    if (IsPythonReady("python", "--version"))
    {
        return ("python", "");
    }

    if (IsPythonReady("py", "-3 --version"))
    {
        return ("py", "-3 ");
    }

    return null;
}

var appDir = AppDir();
var serverPath = Path.Combine(appDir, "server.py");

Console.Title = "JANJA v0.1.0";
Console.WriteLine("JANJA v0.1.0 - Janela de Acesso Nativo e Jornada Assistida");
Console.WriteLine();

if (!File.Exists(serverPath))
{
    Console.WriteLine($"server.py nao encontrado em: {serverPath}");
    Console.WriteLine("Deixe o JANJA.exe na raiz da pasta JANJA-v0.1.0.");
    Console.WriteLine();
    Console.WriteLine("Pressione Enter para sair.");
    Console.ReadLine();
    return 1;
}

var python = FindPython();
if (python is null)
{
    Console.WriteLine("Python nao encontrado.");
    Console.WriteLine("Instale o Python ou defina a variavel JANJA_PYTHON apontando para python.exe.");
    Console.WriteLine();
    Console.WriteLine("Pressione Enter para sair.");
    Console.ReadLine();
    return 1;
}

var serverArgs = $"\"{serverPath}\"";
var arguments = python.Value.ArgumentsPrefix + serverArgs;

using var server = new Process();
server.StartInfo = new ProcessStartInfo
{
    FileName = python.Value.FileName,
    Arguments = arguments,
    WorkingDirectory = appDir,
    UseShellExecute = false,
    RedirectStandardOutput = false,
    RedirectStandardError = false
};

Console.WriteLine($"Iniciando servidor com: {python.Value.FileName} {arguments}");
Console.WriteLine();

try
{
    server.Start();
    server.WaitForExit();
    return server.ExitCode;
}
catch (Exception ex)
{
    Console.WriteLine("Nao foi possivel iniciar o servidor.");
    Console.WriteLine(ex.Message);
    Console.WriteLine();
    Console.WriteLine("Pressione Enter para sair.");
    Console.ReadLine();
    return 1;
}
