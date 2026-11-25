<#
  Activa o desactiva la autenticación de Mosquitto.

  .\scripts\auth-mosquitto.ps1 -Estado
  .\scripts\auth-mosquitto.ps1 -Activar [-Usuario nexus] [-Password "MiClave123"]
  .\scripts\auth-mosquitto.ps1 -Desactivar

  Al activar crea el archivo de contraseñas, ajusta mosquitto.conf, reinicia el
  servicio y genera cps_ia\mqtt_credenciales.json para el motor IA.
#>
[CmdletBinding()]
param(
  [switch]$Activar,
  [switch]$Desactivar,
  [switch]$Estado,
  [string]$Usuario = 'nexus',
  [string]$Password = '',
  [switch]$Elevado
)

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# Constantes
$Raiz      = Split-Path -Parent $PSScriptRoot
$Conf      = 'C:\Program Files\mosquitto\mosquitto.conf'
$Passwd    = 'C:\ProgramData\nexus\mosquitto.passwd'
$Mosquitto = 'C:\Program Files\mosquitto'
$CredIA    = Join-Path $Raiz 'cps_ia\mqtt_credenciales.json'
$DirEstado = Join-Path $Raiz '.nexus'
$Respaldo  = Join-Path $DirEstado 'mosquitto.conf.original'

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

function Test-Administrador {
  $identidad = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identidad)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

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

# Lee y escribe el .conf en UTF-8 SIN BOM (un BOM rompería el arranque del broker).
function Read-Conf {
  [System.IO.File]::ReadAllLines($Conf, [System.Text.Encoding]::UTF8)
}

function Write-Conf {
  param([string[]]$Lineas)
  [System.IO.File]::WriteAllLines($Conf, $Lineas, [System.Text.UTF8Encoding]::new($false))
}

function Set-Directivas {
  param([bool]$ConAutenticacion)

  $lineas = Read-Conf | Where-Object {
    $_ -notmatch '^\s*allow_anonymous\s' -and $_ -notmatch '^\s*password_file\s'
  }

  if ($ConAutenticacion) {
    $bloque = @(
      '',
      '# Autenticacion: acceso con usuario/contrasena (scripts\auth-mosquitto.ps1)',
      'allow_anonymous false',
      "password_file $Passwd"
    )
  } else {
    $bloque = @(
      '',
      '# Autenticacion desactivada: acceso anonimo de laboratorio',
      'allow_anonymous true'
    )
  }

  Write-Conf -Lineas ($lineas + $bloque)
}

function Restart-Broker {
  Restart-Service -Name mosquitto -Force
  for ($i = 0; $i -lt 25; $i++) {
    if (Test-Puerto 1883) { break }
    Start-Sleep -Milliseconds 200
  }
  return (Test-Puerto 1883)
}

function New-Password {
  $caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  -join (1..18 | ForEach-Object { $caracteres[(Get-Random -Maximum $caracteres.Length)] })
}

function Test-Anonimo {
  & (Join-Path $Mosquitto 'mosquitto_pub.exe') -h 127.0.0.1 -t 'nexus/selftest' -m 'ping' *> $null
  return ($LASTEXITCODE -eq 0)
}

function Test-ConCredenciales {
  param([string]$User, [string]$Pass)
  & (Join-Path $Mosquitto 'mosquitto_pub.exe') -h 127.0.0.1 -u $User -P $Pass -t 'nexus/selftest' -m 'ping' *> $null
  return ($LASTEXITCODE -eq 0)
}

# Acciones
function Show-Estado {
  $lineas = Read-Conf
  $anon = [bool]($lineas | Where-Object { $_ -match '^\s*allow_anonymous\s+true' })
  $pass = [bool]($lineas | Where-Object { $_ -match '^\s*password_file\s' })

  Write-Titulo 'Estado de la autenticación MQTT'
  Write-Host ('  {0,-22} {1}' -f 'Broker 1883', $(if (Test-Puerto 1883) { 'ACTIVO' } else { 'PARADO' }))
  Write-Host ('  {0,-22} {1}' -f 'allow_anonymous', $(if ($anon) { 'true  (acceso libre)' } else { 'false (con credenciales)' }))
  Write-Host ('  {0,-22} {1}' -f 'password_file', $(if ($pass) { 'configurado' } else { 'no configurado' }))
  Write-Host ('  {0,-22} {1}' -f 'Archivo de claves', $(if (Test-Path $Passwd) { $Passwd } else { 'no existe' }))
  Write-Host ('  {0,-22} {1}' -f 'Credenciales del motor IA', $(if (Test-Path $CredIA) { 'sí (mqtt_credenciales.json)' } else { 'no' }))
  if (Test-Puerto 1883) {
    Write-Host ('  {0,-22} {1}' -f 'Conexión anónima', $(if (Test-Anonimo) { 'permitida' } else { 'rechazada' }))
  }
}

function Invoke-Activar {
  if (-not (Test-Administrador)) {
    Write-Aviso 'Hace falta administrador: abriendo UAC...'
    Start-Elevado
    return
  }

  Write-Titulo 'Activando autenticación en Mosquitto'

  if (-not (Test-Path -LiteralPath $Conf)) {
    Write-Fallo "No se encuentra $Conf"
    return
  }

  # 1) Copia de seguridad (la primera vez, la original; siempre una con fecha)
  if (-not (Test-Path -LiteralPath $DirEstado)) {
    New-Item -ItemType Directory -Path $DirEstado -Force | Out-Null
  }
  if (-not (Test-Path -LiteralPath $Respaldo)) {
    Copy-Item -LiteralPath $Conf -Destination $Respaldo -Force
    Write-Ok "Copia de seguridad: $Respaldo"
  }
  Copy-Item -LiteralPath $Conf -Destination (Join-Path $DirEstado "mosquitto.conf.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')") -Force

  # 2) Usuario y contraseña
  if (-not $Password) {
    $Password = New-Password
    Write-Aviso 'No se indicó contraseña: se ha generado una aleatoria.'
  }
  $dirPasswd = Split-Path -Parent $Passwd
  if (-not (Test-Path -LiteralPath $dirPasswd)) {
    New-Item -ItemType Directory -Path $dirPasswd -Force | Out-Null
  }
  $herramienta = Join-Path $Mosquitto 'mosquitto_passwd.exe'
  if (-not (Test-Path -LiteralPath $herramienta)) {
    Write-Fallo "No se encuentra $herramienta"
    return
  }
  if (Test-Path -LiteralPath $Passwd) {
    & $herramienta -b $Passwd $Usuario $Password | Out-Null
  } else {
    & $herramienta -c -b $Passwd $Usuario $Password | Out-Null
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Fallo 'mosquitto_passwd falló al crear el archivo de claves.'
    return
  }
  Write-Ok "Usuario '$Usuario' guardado en $Passwd"

  # 3) Directivas en el .conf
  Set-Directivas -ConAutenticacion $true
  Write-Ok 'mosquitto.conf: allow_anonymous false + password_file'

  # 4) Reinicio y comprobación real
  if (-not (Restart-Broker)) {
    Write-Fallo 'El broker no responde tras reiniciar. Restaurando copia de seguridad...'
    Copy-Item -LiteralPath $Respaldo -Destination $Conf -Force
    Restart-Service -Name mosquitto -Force -ErrorAction SilentlyContinue
    return
  }
  Write-Ok 'Servicio reiniciado en 1883/TCP y 9001/WS'

  $anonimo = Test-Anonimo
  $autenticado = Test-ConCredenciales -User $Usuario -Pass $Password
  if ($anonimo) { Write-Aviso 'El acceso anónimo sigue permitido (revisa el .conf).' }
  else { Write-Ok 'Acceso anónimo rechazado (correcto).' }
  if ($autenticado) { Write-Ok 'Acceso con usuario/contraseña aceptado (correcto).' }
  else { Write-Fallo 'El acceso con credenciales falla: revisa el .conf y el passwd.' }

  # 5) Credenciales para el motor IA
  $json = [ordered]@{ usuario = $Usuario; password = $Password } | ConvertTo-Json
  [System.IO.File]::WriteAllText($CredIA, $json, [System.Text.UTF8Encoding]::new($false))
  Write-Ok "Credenciales del motor IA: $CredIA"

  # 6) Resumen para el usuario
  Write-Titulo 'Credenciales'
  Write-Host ('  {0,-12} {1}' -f 'Usuario', $Usuario) -ForegroundColor White
  Write-Host ('  {0,-12} {1}' -f 'Contraseña', $Password) -ForegroundColor White

  Write-Titulo 'Siguientes pasos'
  Write-Paso '1) Reinicia el motor IA: .\scripts\nexus.ps1 -Detener y vuelve a arrancarlo'
  Write-Paso '2) HUD -> botón "CREDENCIALES MQTT" -> usuario y contraseña -> GUARDAR Y RECONECTAR'
  Write-Paso '3) ESP32: rellena MQTT_USER y MQTT_PASS en el .ino y vuelve a flashear'
  Write-Host ''
  Write-Aviso 'Hasta que hagas 1-3, el HUD, la IA y el ESP32 no podrán publicar.'
  Write-Paso 'Para volver atrás:  scripts\auth-mosquitto.ps1 -Desactivar'
}

function Invoke-Desactivar {
  if (-not (Test-Administrador)) {
    Write-Aviso 'Hace falta administrador: abriendo UAC...'
    Start-Elevado
    return
  }

  Write-Titulo 'Desactivando autenticación (volver a acceso anónimo)'

  if (Test-Path -LiteralPath $Respaldo) {
    Copy-Item -LiteralPath $Respaldo -Destination $Conf -Force
    Write-Ok 'mosquitto.conf restaurado desde la copia de seguridad'
  } else {
    Set-Directivas -ConAutenticacion $false
    Write-Ok 'mosquitto.conf: allow_anonymous true (sin password_file)'
  }

  if (-not (Restart-Broker)) {
    Write-Fallo 'El broker no responde tras reiniciar. Revisa el .conf.'
    return
  }
  Write-Ok 'Servicio reiniciado en 1883/TCP y 9001/WS'

  if (Test-Path -LiteralPath $CredIA) {
    Remove-Item -LiteralPath $CredIA -Force
    Write-Ok 'Credenciales del motor IA eliminadas'
  }

  Write-Host ''
  Write-Paso 'Reinicia el motor IA para que vuelva a conectar sin credenciales.'
  Write-Aviso 'Borra también las credenciales del HUD (CREDENCIALES MQTT -> BORRAR).'
}

# Principal
try {
  $Host.UI.RawUI.WindowTitle = 'NEXUS - Autenticacion Mosquitto'
} catch { }

if ($Estado) { Show-Estado; exit 0 }
if ($Activar) { Invoke-Activar; exit 0 }
if ($Desactivar) { Invoke-Desactivar; exit 0 }

Write-Host ''
Write-Host '  Uso:' -ForegroundColor White
Write-Host '    scripts\auth-mosquitto.ps1 -Estado'
Write-Host '    scripts\auth-mosquitto.ps1 -Activar [-Usuario nexus] [-Password "..." ]'
Write-Host '    scripts\auth-mosquitto.ps1 -Desactivar'
Write-Host ''
