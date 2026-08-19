# JANJA

**Janela de Acesso Nativo e Jornada Assistida**

Versao: `v0.1.0`

<table>
  <tr>
    <td>
      <a href="releases/JANJA-v0.1.0.zip?raw=1"><strong>Baixar JANJA v0.1.0 (.zip)</strong></a>
    </td>
  </tr>
</table>

MVP em Python para compartilhar a tela pelo navegador usando WebRTC. O Python serve a pagina e faz a sinalizacao por WebSocket; o video vai direto entre navegadores quando a rede permite.

Nao precisa instalar bibliotecas externas.

## Rodar localmente

Pelo executavel:

```powershell
.\JANJA.exe
```

Mantenha o `cloudflared.exe` na mesma pasta do `JANJA.exe`. Ele e usado para criar o link publico do Cloudflare Tunnel.

Ou pelo Python:

```powershell
python server.py
```

Ao iniciar, o servidor abre o navegador automaticamente em:

```text
http://localhost:3000/host
```

Clique em **Iniciar compartilhamento** e autorize o navegador.

No campo **Audio**, escolha:

- **Escolher tela/janela/guia** para abrir o seletor completo do navegador e transmitir tela inteira, janela ou uma aba.
- **Guia atual com audio** para permitir diretamente a aba atual, com audio da guia.
- **Entrada do Windows** para transmitir uma entrada de audio separada.
- **Sem audio** para transmitir so video.

Para evitar que Discord, Spotify ou outras abas saiam na transmissao, use **Escolher tela/janela/guia**, escolha uma aba no popup do Chrome/Edge e marque **Compartilhar audio da guia**. Nesse modo o navegador envia somente o audio daquela aba.

## Expor por tunel

O `server.py` tenta iniciar o Cloudflare Tunnel automaticamente. Para isso, deixe `cloudflared.exe` nesta pasta ou instale o `cloudflared` no PATH do Windows.

Quando o tunel ficar pronto, a pagina `/host` mostra o link `/watch` com botao **Copiar**.

Se quiser rodar sem abrir o navegador automaticamente:

```powershell
$env:OPEN_BROWSER="0"; python server.py
```

Se quiser rodar sem tunel:

```powershell
$env:DISABLE_TUNNEL="1"; python server.py
```

## Observacoes

- O host precisa iniciar a captura manualmente; o navegador nao permite capturar tela escondido.
- O visitante pode usar o controle de volume na pagina `/watch`.
- O botao **Tela cheia** expande a area do video no host ou no visitante.
- Navegadores nao permitem remover o audio de uma aba ou aplicativo especifico quando voce captura o audio do sistema inteiro. A alternativa sem aplicativos externos e compartilhar uma aba especifica com audio da guia.
- O helper `audio-helper` ficou no projeto como experimento de captura por processo no Windows, mas o caminho recomendado do MVP e a captura nativa por aba.

## Teste do audio filtrado

Com o servidor rodando, valide o mock de audio:

```powershell
node .\tests\audio-stream-smoke.js mock
```

Para testar mistura com PIDs reais:

```powershell
node .\tests\audio-stream-smoke.js 1234,5678
```

Para testar o filtro usando fontes mockadas:

```powershell
node .\tests\audio-filter-mock.js
```

Para testar o caminho usado pela transmissao WebRTC:

```powershell
node .\tests\audio-current-smoke.js
```

Para testar o caminho do navegador com audio mockado, abra:

```text
http://localhost:3000/host?mockAudio=1
```

Marque algum app como **Excluir** e inicie o compartilhamento. Nesse modo, a faixa de audio filtrada vem de um tom sintetico do servidor, sem depender de apps reais tocando audio.

Tambem e possivel validar o stream WAV direto:

```text
http://localhost:3000/audio-preview.wav?mock=1&includePids=101,202
```
- O Quick Tunnel e bom para teste/MVP. Para um link fixo, use Cloudflare Tunnel gerenciado com dominio.
- O MVP usa STUN publico do Google. Em algumas redes restritas, WebRTC pode precisar de um servidor TURN para funcionar.
