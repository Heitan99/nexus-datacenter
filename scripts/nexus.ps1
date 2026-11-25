<#
  Arranque y parada de NEXUS.

  .\scripts\nexus.ps1                        arranca Mosquitto, web y motor IA
  .\scripts\nexus.ps1 -Estado                muestra el estado de las tres piezas
  .\scripts\nexus.ps1 -Detener               para la web y el motor IA
  .\scripts\nexus.ps1 -Detener -ConBroker    además para Mosquitto
  .\scripts\nexus.ps1 -SinIA                 arranca sin el motor Chronos-2
  .\scripts\nexus.ps1 -SinNavegador          no abre el navegador

  El estado de los procesos arrancados se guarda en .nexus\estado.json para no
  tocar procesos ajenos al detener.
#>
[CmdletBinding()]
param(
  [switch]$Detener,
  [switch]$Estado,
  [switch]$SinIA,
  [switch]$SinNavegador,
  [switch]$ConBroker,
  [switch]$Elevado
)

$ErrorActionPreference = 'Stop'

# Consola en UTF-8: los acentos y símbolos salen bien en Windows PowerShell 5.1.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# Constantes
$Raiz         = Split-Path -Parent $PSScriptRoot          # scripts\ -> D:\DataCenter
$DirEstado    = Join-Path $Raiz '.nexus'
$ArchivoEstado = Join-Path $DirEstado 'estado.json'
$PuertoMQTT   = 1883
$PuertoWS     = 9001
$PuertoWeb    = 8123
$UrlHud       = "http://127.0.0.1:$PuertoWeb/"
$ScriptIA     = Join-Path $Raiz 'cps_ia\iniciar_ia.cmd'
$DbHistorico  = Join-Path $Raiz 'cps_ia\datacenter_historico.db'

# Utilidades
function Write-Paso  { param([string]$Texto) Write-Host "  $Texto" }
function Write-Ok    { param([string]$Texto) Write-Host "  [OK] $Texto" -ForegroundColor Green }
function Write-Aviso { param([string]$Texto) Write-Host "  [!]  $Texto" -ForegroundColor Yellow }
function Write-Fallo { param([string]$Texto) Write-Host "  [X]  $Texto" -ForegroundColor Red }

function Write-Titulo {
  param([string]$Texto)
  Write-Host ''
  Write-Host "  $Texto" -ForegroundColor Cyan
  Write-Host ('  ' + ('-' * $Texto.Length)) -ForegroundColor DarkCyan
}

# ¿Hay algo escuchando en 127.0.0.1:<puerto>? (sonda rápida, sin depender del firewall)
function Test-Puerto {
  param([int]$Puerto)
  $cliente = New-Object System.Net.Sockets.TcpClient
  try {
    $tarea = $cliente.ConnectAsync('127.0.0.1', $Puerto)
    if (-not $tarea.Wait(500)) { return $false }
    return $cliente.Connected
  } catch {
    return $false
  } finally {
    $cliente.Close()
  }
}

function Test-Administrador {
  $identidad = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identidad)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Relanza este mismo script pidiendo UAC, conservando los parámetros recibidos.
function Start-Elevado {
  $lista = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  foreach ($clave in $PSBoundParameters.Keys) {
    if ($clave -eq 'Elevado') { continue }
    $valor = $PSBoundParameters[$clave]
    if ($valor -is [switch] -or $valor -is [bool]) {
      if ($valor) { $lista += "-$clave" }
    } else {
      $lista += "-$clave"
      $lista += "`"$valor`""
    }
  }
  $lista += '-Elevado'
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $lista | Out-Null
}

function Get-EstadoGuardado {
  if (Test-Path -LiteralPath $ArchivoEstado) {
    try { return Get-Content -LiteralPath $ArchivoEstado -Raw | ConvertFrom-Json } catch { }
  }
  return $null
}

function Set-EstadoGuardado {
  param($Datos)
  if (-not (Test-Path -LiteralPath $DirEstado)) {
    New-Item -ItemType Directory -Path $DirEstado -Force | Out-Null
  }
  $Datos | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ArchivoEstado -Encoding UTF8
}

function Test-ProcesoVivo {
  param([int]$IdProceso)
  if (-not $IdProceso) { return $false }
  return $null -ne (Get-Process -Id $IdProceso -ErrorAction SilentlyContinue)
}

# Busca procesos de Python por su línea de comandos (útil si se perdió el PID).
# Se filtra por nombre porque el alias de WindowsApps se ejecuta como
# "python3.13.exe", no como "python.exe".
function Get-ProcesosPorLinea {
  param([string]$Patron)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match $Patron -and
      $_.Name -match '^(python|pythonw|py)[0-9.]*\.exe$'
    }
}

function Stop-Arbol {
  param([int]$IdProceso, [string]$Etiqueta)
  if (-not (Test-ProcesoVivo $IdProceso)) { return $false }
  & taskkill.exe /PID $IdProceso /T /F *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "$Etiqueta detenido (PID $IdProceso)"
    return $true
  }
  Write-Aviso "No se pudo detener $Etiqueta (PID $IdProceso)"
  return $false
}

function Stop-PorPatron {
  param([string]$Patron, [string]$Etiqueta)
  $detenidos = 0
  foreach ($proceso in (Get-ProcesosPorLinea $Patron)) {
    if (Stop-Arbol -IdProceso $proceso.ProcessId -Etiqueta $Etiqueta) { $detenidos++ }
  }
  return $detenidos
}

# IP de la interfaz con puerta de enlace (la que ve el ESP32 en la LAN).
function Get-IpLan {
  try {
    $config = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
      Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
      Select-Object -First 1
    if ($config) { return $config.IPv4Address.IPAddress }
  } catch { }
  return $null
}

# Acciones
function Start-Broker {
  Write-Titulo '1/3  Broker MQTT (Mosquitto)'

  if (Test-Puerto $PuertoMQTT) {
    Write-Ok "Escuchando en $PuertoMQTT/TCP y $PuertoWS/WS"
    return $true
  }

  $servicio = Get-Service -Name mosquitto -ErrorAction SilentlyContinue
  if (-not $servicio) {
    Write-Fallo "No existe el servicio 'mosquitto' en este equipo."
    Write-Paso 'Instálalo con:  winget install Mosquitto.Mosquitto'
    return $false
  }

  if (-not (Test-Administrador)) {
    Write-Aviso 'El servicio está parado y hace falta administrador: abriendo UAC...'
    Start-Elevado
    return $false
  }

  try {
    Start-Service -Name mosquitto
    for ($i = 0; $i -lt 25; $i++) {
      if (Test-Puerto $PuertoMQTT) { break }
      Start-Sleep -Milliseconds 200
    }
  } catch {
    Write-Fallo "No se pudo iniciar el servicio: $($_.Exception.Message)"
    return $false
  }

  if (Test-Puerto $PuertoMQTT) {
    Write-Ok "Servicio iniciado en $PuertoMQTT/TCP y $PuertoWS/WS"
    return $true
  }

  Write-Fallo 'El servicio arrancó pero el puerto no responde. Revisa mosquitto.conf.'
  return $false
}

function Ensure-ReglaFirewall {
  param([string]$Nombre, [int]$Puerto)
  if (-not (Test-Administrador)) { return }
  try {
    $existe = Get-NetFirewallRule -DisplayName $Nombre -ErrorAction SilentlyContinue
    if ($existe) { return }
    New-NetFirewallRule -DisplayName $Nombre -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $Puerto -Profile Private, Domain | Out-Null
    Write-Ok "Regla de firewall creada: $Nombre (TCP $Puerto)"
  } catch {
    Write-Aviso "No se pudo crear la regla de firewall '$Nombre'."
  }
}

function Start-Web {
  Write-Titulo "2/3  Servidor web (puerto $PuertoWeb)"

  if (Test-Puerto $PuertoWeb) {
    Write-Ok "Ya está sirviendo en $UrlHud"
    return $true
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  $ejecutable = $null
  $argumentos = @()
  if ($python) {
    $ejecutable = $python.Source
    $argumentos = @('-m', 'http.server', "$PuertoWeb", '--bind', '127.0.0.1')
  } else {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
      $ejecutable = $py.Source
      $argumentos = @('-3', '-m', 'http.server', "$PuertoWeb", '--bind', '127.0.0.1')
    }
  }

  if (-not $ejecutable) {
    Write-Fallo 'No se encontró Python. Instálalo y marca "Add python.exe to PATH".'
    return $false
  }

  try {
    $proceso = Start-Process -FilePath $ejecutable -ArgumentList $argumentos `
      -WorkingDirectory $Raiz -WindowStyle Hidden -PassThru
  } catch {
    Write-Fallo "No se pudo lanzar el servidor web: $($_.Exception.Message)"
    return $false
  }

  for ($i = 0; $i -lt 40; $i++) {
    if (Test-Puerto $PuertoWeb) { break }
    Start-Sleep -Milliseconds 200
  }

  if (-not (Test-Puerto $PuertoWeb)) {
    Write-Fallo 'El servidor web no abrió el puerto. Prueba manualmente:'
    Write-Paso "cd `"$Raiz`"; python -m http.server $PuertoWeb --bind 127.0.0.1"
    return $false
  }

  Write-Ok "Sirviendo en $UrlHud (PID $($proceso.Id))"
  return $true
}

function Start-MotorIA {
  Write-Titulo '3/3  Motor de IA (Chronos-2)'

  $yaCorriendo = Get-ProcesosPorLinea 'ia_chronos_mqtt\.py'
  if ($yaCorriendo) {
    $pids = ($yaCorriendo | ForEach-Object { $_.ProcessId }) -join ', '
    Write-Ok "Ya está en marcha (PID $pids)"
    return $true
  }

  if (-not (Test-Path -LiteralPath $ScriptIA)) {
    Write-Fallo "No se encuentra $ScriptIA"
    return $false
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Raiz 'cps_ia\.venv\Scripts\python.exe'))) {
    Write-Fallo 'Falta el entorno virtual cps_ia\.venv'
    Write-Paso 'Créalo con: cd cps_ia; python -m venv .venv; .venv\Scripts\python.exe -m pip install chronos-forecasting paho-mqtt'
    return $false
  }

  try {
    # Ventana propia: ahí se ve la carga del modelo y las inferencias.
    $proceso = Start-Process -FilePath $ScriptIA -WorkingDirectory (Split-Path $ScriptIA) -PassThru
  } catch {
    Write-Fallo "No se pudo lanzar el motor IA: $($_.Exception.Message)"
    return $false
  }

  # Damos unos segundos: si el proceso muere, casi siempre es un error de dependencias.
  Start-Sleep -Seconds 6
  if (-not (Test-ProcesoVivo $proceso.Id) -and -not (Get-ProcesosPorLinea 'ia_chronos_mqtt\.py')) {
    Write-Fallo 'El motor IA terminó al arrancar. Revisa su ventana o ejecuta:'
    Write-Paso "`"$ScriptIA`""
    return $false
  }

  Write-Ok "Lanzado (PID $($proceso.Id)). La primera inferencia tarda unos segundos."
  return $true
}

function Show-Estado {
  $guardado = Get-EstadoGuardado

  Write-Titulo 'Estado de NEXUS'

  # Broker
  if (Test-Puerto $PuertoMQTT) {
    $ws = if (Test-Puerto $PuertoWS) { 'sí' } else { 'no' }
    Write-Host ('  {0,-12} {1}' -f 'Mosquitto', "ACTIVO  ($PuertoMQTT/TCP, WebSocket $ws)") -ForegroundColor Green
  } else {
    Write-Host ('  {0,-12} {1}' -f 'Mosquitto', 'PARADO') -ForegroundColor Red
  }

  # Web
  if (Test-Puerto $PuertoWeb) {
    Write-Host ('  {0,-12} {1}' -f 'Web HUD', "ACTIVO  ($UrlHud)") -ForegroundColor Green
  } else {
    Write-Host ('  {0,-12} {1}' -f 'Web HUD', 'PARADO') -ForegroundColor Red
  }

  # Motor IA
  $procesosIA = Get-ProcesosPorLinea 'ia_chronos_mqtt\.py'
  if ($procesosIA) {
    $pids = ($procesosIA | ForEach-Object { $_.ProcessId }) -join ', '
    Write-Host ('  {0,-12} {1}' -f 'Motor IA', "ACTIVO  (PID $pids)") -ForegroundColor Green
  } else {
    Write-Host ('  {0,-12} {1}' -f 'Motor IA', 'PARADO') -ForegroundColor Red
  }

  # Histórico
  if (Test-Path -LiteralPath $DbHistorico) {
    $tam = [math]::Round((Get-Item -LiteralPath $DbHistorico).Length / 1KB, 1)
    $mod = (Get-Item -LiteralPath $DbHistorico).LastWriteTime.ToString('dd/MM/yyyy HH:mm:ss')
    Write-Host ('  {0,-12} {1}' -f 'Histórico', "$tam KB, última escritura $mod")
  } else {
    Write-Host ('  {0,-12} {1}' -f 'Histórico', 'sin base de datos todavía')
  }

  $ip = Get-IpLan
  if ($ip) { Write-Host ('  {0,-12} {1}' -f 'IP LAN', "$ip  (la que usa el ESP32)") }

  if ($guardado -and $guardado.iniciado) {
    Write-Host ''
    Write-Paso "Último arranque desde este lanzador: $($guardado.iniciado)"
  }
}

function Invoke-Detener {
  Write-Titulo 'Deteniendo NEXUS'
  $guardado = Get-EstadoGuardado
  $algo = $false

  if ($guardado -and $guardado.web) {
    if (Stop-Arbol -IdProceso ([int]$guardado.web) -Etiqueta 'Servidor web') { $algo = $true }
  }
  if ((Stop-PorPatron -Patron 'http\.server\s+8123' -Etiqueta 'Servidor web') -gt 0) { $algo = $true }

  if ($guardado -and $guardado.ia) {
    if (Stop-Arbol -IdProceso ([int]$guardado.ia) -Etiqueta 'Motor IA') { $algo = $true }
  }
  if ((Stop-PorPatron -Patron 'ia_chronos_mqtt\.py' -Etiqueta 'Motor IA') -gt 0) { $algo = $true }

  if ($ConBroker) {
    $servicio = Get-Service -Name mosquitto -ErrorAction SilentlyContinue
    if ($servicio -and $servicio.Status -eq 'Running') {
      if (Test-Administrador) {
        Stop-Service -Name mosquitto
        Write-Ok 'Servicio Mosquitto detenido'
        $algo = $true
      } else {
        Write-Aviso 'Para detener el broker hace falta administrador: abriendo UAC...'
        Start-Elevado
        return
      }
    }
  }

  if (Test-Path -LiteralPath $ArchivoEstado) {
    Remove-Item -LiteralPath $ArchivoEstado -Force -ErrorAction SilentlyContinue
  }

  if (-not $algo) { Write-Paso 'No había nada que detener.' }
  else { Write-Host ''; Write-Ok 'Listo. Mosquitto sigue como servicio (se inicia solo con Windows).' }
}

function Invoke-Arranque {
  Write-Host ''
  Write-Host '  NEXUS — gemelo digital del Data Center' -ForegroundColor White
  Write-Host '  Arrancando broker, HUD y motor de IA...' -ForegroundColor DarkGray

  $brokerOk = Start-Broker
  if (-not $brokerOk) {
    Write-Host ''
    Write-Fallo 'Sin broker no hay telemetría. Corrige el paso 1 y vuelve a intentarlo.'
    return 1
  }

  Ensure-ReglaFirewall -Nombre 'Mosquitto MQTT 1883' -Puerto $PuertoMQTT
  Ensure-ReglaFirewall -Nombre 'NEXUS HUD 8123' -Puerto $PuertoWeb

  $webOk = Start-Web
  $iaOk = $true
  if ($SinIA) {
    Write-Titulo '3/3  Motor de IA (omitido con -SinIA)'
  } else {
    $iaOk = Start-MotorIA
  }

  # Guardamos los PID para que "detener" solo cierre lo nuestro.
  $anterior = Get-EstadoGuardado
  $datos = [ordered]@{
    iniciado = (Get-Date).ToString('dd/MM/yyyy HH:mm:ss')
    web      = $null
    ia       = $null
  }
  if ($anterior) {
    if (Test-ProcesoVivo ([int]$anterior.web)) { $datos.web = [int]$anterior.web }
    if (Test-ProcesoVivo ([int]$anterior.ia))  { $datos.ia  = [int]$anterior.ia }
  }
  # Start-Web/Start-MotorIA no devuelven el PID; lo recuperamos del sistema.
  $procesoWeb = Get-ProcesosPorLinea 'http\.server\s+8123' | Select-Object -First 1
  if ($procesoWeb) { $datos.web = $procesoWeb.ProcessId }
  $procesoIA = Get-ProcesosPorLinea 'ia_chronos_mqtt\.py' | Select-Object -First 1
  if ($procesoIA) { $datos.ia = $procesoIA.ProcessId }
  Set-EstadoGuardado $datos

  # Resumen final
  Write-Titulo 'NEXUS en marcha'
  $ip = Get-IpLan
  Write-Host ('  {0,-12} {1}' -f 'HUD', $UrlHud) -ForegroundColor White
  if ($ip) {
    Write-Host ('  {0,-12} {1}' -f 'ESP32', "$ip`:$PuertoMQTT  (broker para el firmware)")
  }
  Write-Host ('  {0,-12} {1}' -f 'WebSocket', "ws://127.0.0.1:$PuertoWS  (lo usa el navegador)")
  Write-Host ('  {0,-12} {1}' -f 'Histórico', $DbHistorico)
  if (-not $iaOk) {
    Write-Host ''
    Write-Aviso 'El motor IA no arrancó: el HUD y el simulador funcionan, pero sin predicciones.'
  }
  if (-not $webOk) {
    Write-Host ''
    Write-Aviso 'El servidor web no arrancó: revisa el mensaje anterior.'
  }

  if (-not $SinNavegador) {
    Start-Process $UrlHud | Out-Null
    Write-Host ''
    Write-Paso 'Abriendo el HUD en el navegador...'
  }

  Write-Host ''
  Write-Paso 'Para pararlo:  .\scripts\nexus.ps1 -Detener'
  Write-Host ''
  return 0
}

# Principal
try {
  $Host.UI.RawUI.WindowTitle = 'NEXUS'
} catch { }

if ($Estado) {
  Show-Estado
  exit 0
}

if ($Detener) {
  Invoke-Detener
  exit 0
}

# Si el broker está parado y no somos administradores, nos elevamos una vez.
if (-not (Test-Puerto $PuertoMQTT) -and -not (Test-Administrador)) {
  Write-Aviso 'Mosquitto está parado; se necesitan permisos de administrador.'
  Write-Paso 'Abriendo una ventana elevada (acepta el aviso de UAC)...'
  Start-Elevado
  exit 0
}

exit (Invoke-Arranque)
