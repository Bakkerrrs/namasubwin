# NamaSub para Windows

App de escritorio para **mirar contenido japonés con subtítulos en español
generados en vivo**. Captura cualquier fuente de video/audio del PC (estilo
OBS), translitera y traduce la capa de audio con OpenAI, y reproduce el video
**dentro de la app** con los subtítulos quemados como capa de imagen encima.

Es la hermana Windows de [namasub_ios](https://github.com/Bakkerrrs/namasub_ios):
comparte los mismos prompts de traducción, los parámetros de VAD y el pipeline
audio → transcripción → traducción por la **Realtime API** de OpenAI. Lo que en
iOS es imposible (capturar el audio del sistema), en Windows es el modo por
defecto.

## Cómo resuelve la sincronía (video diferido)

La transcripción + traducción tardan unos segundos en llegar. En vez de mostrar
los subtítulos tarde, la app **retrasa el video**:

```
  vivo ──► captura ──► audio → Realtime API (STT + traducción JP→ES)  ~2-4 s
              │
              └──► buffer de N segundos (configurable, 10 s por defecto)
                        │
                        ▼
                   pantalla: video + audio diferidos, con los subtítulos
                   ya listos apareciendo en el instante exacto del habla
```

El reloj del buffer y el reloj del VAD del servidor son el mismo (0 = pulsar
Iniciar), así que cada subtítulo conoce su ventana `[inicio, fin]` de habla y
se dibuja sobre el cuadro correcto. Ves el contenido 10 segundos "en el
pasado", pero perfectamente subtitulado.

## Funciones

- **Fuentes estilo OBS**: pantallas y ventanas con miniatura, cámaras y
  capturadoras (UVC), y como audio el **loopback del sistema** (lo que suena
  por los parlantes) o cualquier entrada (micrófono, line-in).
- **Subtítulos quemados** como capa de imagen sobre el video (opcional
  bilingüe: japonés arriba, español abajo), con **estilo configurable**:
  fuente (cualquier fuente instalada, con sugerencias occidentales y
  japonesas), tamaño (50–200 %) y transparencia del fondo de la región
  (0–100 %). Los cambios se aplican en vivo y quedan guardados.
- **Reproducción en la misma app**, ventana o pantalla completa con
  **Alt+Enter** (o F11).
- **Atraso configurable** (5–25 s) con corrección suave de deriva.
- **VAD ajustable en caliente** (umbral, prefijo, silencio de corte), igual que
  en la app iOS.
- **Traductor de respaldo**: si el canal Realtime transcribe pero no traduce un
  turno, se traduce por REST para que ninguna frase quede sin subtítulo.
- **Ritmo de subtítulos natural**: los turnos largos (habla continua sin
  pausas, típica de TV/anime) no se muestran como un bloque gigante — el texto
  se trocea en subtítulos de ~90 caracteres repartidos proporcionalmente a lo
  largo del turno, y mientras un turno sigue abierto se muestra la cola del
  texto como caption en vivo. Con habla muy continua conviene subir el atraso
  a 12–15 s para que la traducción siempre llegue antes que su cuadro.
- **Guardar la sesión**: video WebM en disco + exportación de subtítulos SRT.
- **API Key segura**: prioridad `OPENAI_API_KEY` de entorno; si se ingresa en
  la app se guarda cifrada con DPAPI (`safeStorage`).

## Requisitos

- Windows 10/11.
- [Node.js](https://nodejs.org) 20 o superior (para ejecutar desde el código).
- Una API Key de OpenAI con acceso a la Realtime API.

## Ejecutar

```bash
npm install
npm start
```

1. Elige la **fuente de video** (pantalla, ventana o cámara/capturadora).
2. Deja el audio en **"Audio del sistema (loopback)"** para transliterar lo que
   suena por los parlantes, o elige una entrada específica.
3. Pega tu **API Key** y pulsa **▶ Iniciar**.
4. El video aparece a los N segundos (el globo indica la cuenta) ya
   subtitulado. Alt+Enter para pantalla completa.

## Pruebas

```bash
npm test
```

Prueban la lógica pura de la línea de tiempo de subtítulos (emparejamiento de
turnos, ventanas de tiempo, respaldo y exportación SRT).

## Estructura

| Archivo | Rol |
|---|---|
| `main.js` | Proceso principal: ventana, Alt+Enter, fuentes, API key, guardado |
| `preload.js` | Puente seguro main ↔ renderer |
| `renderer/app.js` | Orquestación (equivalente al `TranslatorViewModel` de iOS) |
| `renderer/capture.js` | Construcción del stream según la fuente elegida |
| `renderer/delaybuffer.js` | Reproducción diferida (MediaRecorder → MSE) |
| `renderer/realtime.js` | Cliente Realtime API (puerto de `RealtimeService.swift`) + respaldo |
| `renderer/subtitles.js` | Línea de tiempo y exportación SRT (lógica pura, testeada) |
| `renderer/worklets/pcm16.js` | Audio capturado → PCM16 mono 24 kHz |

## Ver y oír todo en el mismo PC (sin eco)

El video nunca es problema: la app lo muestra diferido en su propia ventana.
Con el **audio** hay una trampa: el loopback captura *todo* lo que suena por el
dispositivo de salida por defecto — incluida la reproducción diferida de la
propia app. Si ambas cosas salen por el mismo dispositivo, el audio diferido
vuelve a entrar a la captura: subtítulos duplicados 10 s después y eco
acumulándose.

Por eso el panel tiene **"Salida del reproductor"**: el audio diferido de la
app puede ir a un dispositivo distinto del capturado, lo que corta el bucle.
Dos recetas según tu hardware:

1. **Con dos salidas de audio** (auriculares USB/Bluetooth, HDMI del monitor):
   deja la fuente sonando por la salida por defecto (la que captura el
   loopback) y en la app elige la otra salida (p. ej. los auriculares). Oyes
   solo el diferido por los auriculares; si no quieres oír el vivo de fondo,
   baja el volumen físico de los parlantes (no lo silencies en Windows: el
   loopback captura *después* del volumen maestro y se quedaría sin señal).

2. **Con una sola salida — cable virtual** (la experiencia más limpia):
   instala [VB-Cable](https://vb-audio.com/Cable/) y pon **CABLE Input** como
   dispositivo de salida por defecto de Windows. La fuente "suena" hacia el
   cable (inaudible), el loopback lo captura igual, y en la app eliges tus
   parlantes reales como salida del reproductor. Resultado: oyes **solo** el
   audio diferido, perfectamente sincronizado con el video y los subtítulos,
   todo en el mismo PC.

También puedes enrutar solo la app de origen (navegador, reproductor) a otro
dispositivo desde *Configuración → Sistema → Sonido → Preferencias de volumen
por aplicación* de Windows, sin instalar nada.

## Pantallas HDR (imagen lavada / sin color)

Cuando Windows compone el escritorio en **HDR**, la captura de pantalla llega
al pipeline SDR sin un mapeo de tonos correcto y la imagen se ve **lavada y
desaturada** (le pasa a cualquier capturador; OBS tardó años en resolverlo).
Tres niveles de solución, de mejor a más rápido:

1. **Color perfecto**: desactiva el HDR de Windows mientras uses la app —
   atajo **Win+Alt+B** (Game Bar) o *Configuración → Pantalla → HDR*. Es la
   única forma de que la captura (y la grabación WebM) tengan el color exacto.
2. **Mitigación automática**: la app fuerza el perfil de color sRGB y el
   capturador WGC de Windows, que maneja mejor las superficies HDR que la
   duplicación DXGI clásica. En muchos equipos esto ya corrige gran parte.
3. **Corrección en el reproductor**: panel *Imagen → Corrección de color
   (pantalla HDR)* con intensidad ajustable — re-satura y contrasta la imagen
   diferida. Afecta solo lo que ves en la app, **no** el archivo WebM guardado
   (para grabar con color fiel usa la opción 1).

## Si no aparecen subtítulos (modo debug)

Activa *Depuración → Modo debug* en el panel: sobre el video aparece un
recuadro con el registro en vivo, una línea de estadísticas
(`vivo · video · atraso · subs N/M`) y un **medidor del audio** que viaja a la
API. Diagnóstico rápido:

- **Medidor en 0** → la fuente de audio no entrega señal: revisa que el
  contenido esté sonando por la salida por defecto (loopback) o que elegiste
  la entrada correcta.
- **`ERROR:` en el registro** → la API rechazó algo (key inválida, modelo sin
  acceso, payload). El texto completo del error queda en el registro.
- **`Cerrado: código 1008/4xx`** → autenticación: verifica la API Key y que tu
  cuenta tenga acceso a la Realtime API.
- **Llegan `speechStarted` pero no `inputTranscript`** → el VAD detecta voz
  pero la transcripción falla; el registro muestra los eventos crudos.

El botón **Copiar registro** copia todo al portapapeles para compartirlo.
F12 abre las DevTools de Chromium si necesitas ir más profundo.

## Notas

- El audio de la fuente se envía a la API de OpenAI; revisa los términos según
  tu caso de uso.
- El loopback captura **todo** el audio del sistema: silencia otras apps si no
  quieres que se mezclen en la transliteración.
- La grabación guardada es WebM con el video/audio originales; los subtítulos
  van en el SRT exportado (los reproductores los cargan automáticamente si
  comparten nombre de archivo).
