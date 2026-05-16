# Visualizador de dumps LAMMPS

Aplicación web liviana para visualizar archivos `dump.*` de LAMMPS desde el
navegador. Subís los archivos a un directorio del servidor y se ven en 3D
desde un link, con color por propiedad, filtros por rango y plano de corte.

El backend (FastAPI) parsea los dumps con numpy/pandas, los cachea y los
envía al navegador como **binario float32** —no texto— para que cientos de
miles de átomos se carguen rápido. El frontend usa three.js y dibuja todo
con un solo shader (color/filtro/corte en la GPU).

## Estructura de datos

```
simulations/
  sp3_20/
    dump.ballistic_ac.sp3_20.0
    dump.ballistic_ac.sp3_20.2000
    ...
  proyectoA/sp3_40/          # se admiten subcarpetas anidadas
    dump.ballistic_ac.sp3_40.0
    ...
```

Cada **carpeta con archivos `dump.*`** es una simulación; cada **archivo**
`dump.*` es un timestep. La búsqueda es **recursiva**: cualquier
subdirectorio (a cualquier profundidad) dentro de `simulations/` que
contenga dumps aparece como una corrida, con su ruta relativa como nombre.
El número final del nombre se usa como timestep (si no, se lee del header).
Para agregar datos: copiá una carpeta nueva dentro de `simulations/` y
recargá la web. No hace falta reiniciar el servidor.

Por defecto `DATA_DIR` es `./simulations` (se crea solo al arrancar con
`run.sh`). Cambialo con la variable de entorno `DATA_DIR`.

En el visualizador, el cuadro **Buscar simulación** filtra la lista por
texto (subcadena, sin distinguir mayúsculas); Enter abre la primera
coincidencia.

## Opción A — venv + uvicorn (la más portable)

Requiere Python 3.10+:

```bash
./run.sh
# o personalizado:
DATA_DIR=/scratch/usuario/dumps PORT=8080 ./run.sh
```

Abrí `http://IP_DEL_SERVIDOR:8000`. Para dejarlo corriendo en el servidor:

```bash
nohup ./run.sh > visualizer.log 2>&1 &
```

(o un servicio `systemd` apuntando a `.venv/bin/uvicorn`).

## Opción B — Docker

```bash
docker compose up -d --build
```

Editá el volumen en `docker-compose.yml` para apuntar al directorio real de
dumps. Sirve en el puerto 8000.

## Notas para el servidor IBM de la universidad

- **Puerto / firewall:** elegí el puerto con `PORT` y verificá que esté
  abierto. Si solo hay acceso por SSH, usá un túnel:
  `ssh -L 8000:localhost:8000 usuario@servidor` y abrí `localhost:8000`.
- **Detrás de Nginx/Apache:** proxy-pass normal a `127.0.0.1:8000`.
- **three.js** se carga desde un CDN (jsdelivr). Si el servidor/cliente no
  tiene salida a internet, descargá `three.module.js` y la carpeta
  `examples/jsm/` de three@0.160.0 a `frontend/` y ajustá el `importmap`
  de `index.html` a rutas locales.
- **Memoria:** el backend cachea hasta `FRAME_CACHE` frames (def. 4) en
  RAM (~20-40 MB c/u con ~470k átomos). Subí/bajá con la variable de
  entorno `FRAME_CACHE`.

## API

| Endpoint | Devuelve |
|---|---|
| `GET /api/runs` | corridas y timesteps disponibles (JSON) |
| `GET /api/frame/meta?run=&step=` | nº átomos, caja, campos y rangos (JSON) |
| `GET /api/frame/positions?run=&step=` | `xyz` float32 binario (`n*3`) |
| `GET /api/frame/scalar?run=&step=&field=` | una columna float32 (`n`) |
| `GET /api/frame/histogram?run=&step=&field=&bins=` | bordes y conteos de la distribución (JSON) |

## Histograma interactivo

El panel muestra el histograma de la columna elegida en *Colorear por*
(barras coloreadas con la misma paleta del 3D). **Arrastrá** sobre el
histograma para seleccionar un rango: los átomos fuera de ese rango se
ocultan en la vista 3D al instante. **Doble clic** limpia la selección.
Hay eje Y logarítmico para distribuciones muy sesgadas, y los campos
*Desde/Hasta* quedan sincronizados con la selección.
# simulations-visualizer
