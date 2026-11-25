# Arranque de NEXUS

## Arrancar

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\nexus.ps1
```

El script hace, en orden:

1. Comprueba **Mosquitto** y lo arranca si está parado (`1883/TCP` para el ESP32
   y Python, `9001/WS` para el navegador).
2. Sirve el HUD en **http://127.0.0.1:8123/** con `http.server`.
3. Lanza el **motor IA Chronos-2** (`cps_ia\iniciar_ia.cmd`, con `.venv`) en su
   propia ventana.
4. Abre el HUD en el navegador.

## Parar

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\nexus.ps1 -Detener
```

Detiene el servidor web y el motor IA. Mosquitto **no** se toca: es un servicio
de Windows que arranca solo. Para pararlo también:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\nexus.ps1 -Detener -ConBroker
```

## Comprobar el estado

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\nexus.ps1 -Estado
```

Muestra broker, web, motor IA, tamaño del histórico SQLite y la IP LAN que debe
usar el ESP32.

## Opciones

| Opción | Efecto |
|---|---|
| `-SinIA` | Arranca sin el motor Chronos-2 (solo broker + HUD). |
| `-SinNavegador` | No abre el navegador. |
| `-Detener` | Para web y motor IA. |
| `-ConBroker` | Junto a `-Detener`, para también Mosquitto. |
| `-Estado` | Solo muestra el estado. |

Ejemplo: `.\scripts\nexus.ps1 -SinIA`

## ESP32

El firmware debe apuntar a la IP LAN de este PC, que es donde corre el broker.
Puedes consultarla con `-Estado`. Si el router la cambia por DHCP, conviene
reservarla en el router o fijarla en Windows.

El ESP32 publica JSON (`{"device_id":"esp32-rack01","variable":"temp","value":23.4,...}`)
y tanto el HUD como el motor IA aceptan ese formato (`value`/`valor`).

Con hardware real conectado, **desactiva el simulador** en el HUD (switch SIM):
si no, el simulador y el ESP32 publican en los mismos topics y los valores
parpadean entre reales y simulados.

## Usuario y contraseña en Mosquitto

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\auth-mosquitto.ps1 -Estado
powershell -ExecutionPolicy Bypass -File .\scripts\auth-mosquitto.ps1 -Activar -Usuario nexus -Password "TuClave"
powershell -ExecutionPolicy Bypass -File .\scripts\auth-mosquitto.ps1 -Desactivar
```

Al activar: guarda copia de seguridad del `.conf`, crea
`C:\ProgramData\nexus\mosquitto.passwd`, pone `allow_anonymous false`, reinicia
el servicio, comprueba que el acceso anónimo se rechaza y escribe
`cps_ia\mqtt_credenciales.json` para el motor IA.

Después hay que:

1. Reiniciar el motor IA (`-Detener` y volver a arrancar).
2. HUD → **CREDENCIALES MQTT** → usuario y contraseña → *GUARDAR Y RECONECTAR*.
3. Rellenar `MQTT_USER` / `MQTT_PASS` en el `.ino` y reflashear el ESP32.

`-Desactivar` restaura el `.conf` original, vuelve a `allow_anonymous true` y
borra las credenciales del motor IA.

## Alertas de Telegram

El token del bot y el `chat_id` **no están en el código fuente**. Se configuran
en el HUD:

1. Botón **ALERTAS TG** (pie del panel derecho).
2. Pega el token de @BotFather y el `chat_id`.
3. *GUARDAR*.

Se almacenan en el `localStorage` de ese navegador. Con el switch **TG** del HUD
puedes silenciar o reactivar los envíos sin borrar las credenciales.

## Problemas típicos

- **`ModuleNotFoundError: No module named 'chronos'`** → se ejecutó con el
  Python global. Usa siempre `cps_ia\iniciar_ia.cmd` (o
  `cps_ia\.venv\Scripts\python.exe`).
- **El HUD no conecta** → comprueba que el puerto `9001` responde con
  `-Estado`.
- **El ESP32 no conecta** → puerto `1883` bloqueado por firewall (el script crea
  la regla si se ejecuta como administrador) o IP del broker cambiada.
- **Sin predicciones** → el motor necesita 12 lecturas (~36 s con el simulador)
  antes de publicar `datacenter/rack/<nn>/ia`.

## Archivos implicados

- `scripts\nexus.ps1` — arranque, parada y estado.
- `scripts\auth-mosquitto.ps1` — usuario y contraseña del broker.
- `cps_ia\iniciar_ia.cmd` — arranca el motor IA con su entorno virtual.
- `cps_ia\mqtt_credenciales.json` — credenciales del motor IA (lo crea el script
  anterior).
- `.nexus\estado.json` — PID de lo que arrancó el script (para no cerrar
  procesos ajenos).
