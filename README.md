# SOSER · App del Técnico

Tercer pilar del ecosistema SOSER. El técnico ve **solo los casos que le derivaste** desde el panel admin, los resuelve en terreno y los cierra registrando materiales usados, fotos/videos del trabajo y su ubicación GPS. Al cerrar, el estado pasa a **SOLUCIONADO** en la hoja original — se refleja automáticamente en el panel admin y en la app del encargado.

Sin mapa. Mismo `/exec` y misma planilla. Requiere **Apps Script v5**.

---

## 1. Contenido

```
soser-tecnico/
├── index.html                 App del técnico (sin mapa)
├── app.js                     Lógica completa
├── data.js                    Base de establecimientos
├── icon-192.png               Ícono
├── .nojekyll
└── AppsScript_SOSER_v5.gs     Backend (reemplaza el v4)
```

Además, en la raíz del entregable: **SOSER_Catalogo_Productos.xlsx** — la plantilla para que cargues tu lista de materiales.

PIN de configuración: `123456789`.

---

## 2. Actualizar el backend (Apps Script v5)

Es una extensión del v4, retrocompatible con las apps de encargado y admin.

1. Planilla → **Extensiones → Apps Script** → reemplaza todo por `AppsScript_SOSER_v5.gs`.
2. Ejecuta la función **`primeraVez`** una vez (crea las hojas `Productos` y `Config Técnico`, y verifica las demás).
3. **Implementar → Gestionar implementaciones → lápiz → Nueva versión → Implementar**. Misma URL.

### Hojas nuevas que crea v5
- **`Productos`** — catálogo de materiales. Aquí pegas tu lista (ver punto 4). Columnas: `Producto | Cantidad | Precio | Extra`.
- **`Config Técnico`** — parámetros: qué columnas ve el técnico y el nombre de la 4ª columna cuando lo decidas.
- **Una hoja por técnico** (ej. `Tec-Rodrigo Martínez`) — se crea cuando el técnico entra a su app, elige su nombre y guarda. Lleva prefijo `Tec-` para no colisionar si esa persona también es encargado. Guarda todo el historial con los **materiales expandidos en columnas** (`Material 1 | Cant 1 | Precio 1 | Subtotal 1 | Material 2 | …`) para que sumes fácil.

---

## 3. Publicar la app

Sube `soser-tecnico/` a un repo (o carpeta) en GitHub Pages, igual que las otras dos apps. Requiere HTTPS (GitHub Pages ya lo da) para cámara y GPS.

Cada técnico abre la URL, entra a ⚙️ (PIN `123456789`) y **elige su nombre** de la lista — solo aparecen los técnicos que tú registraste en el panel admin. No pueden escribir un nombre libre.

---

## 4. Cargar el catálogo de productos

1. Abre **SOSER_Catalogo_Productos.xlsx**.
2. Llena la hoja `Productos`: una fila por material. Columna A = nombre, B = cantidad/stock (opcional), C = precio unitario. La 4ª columna queda sin nombre hasta que decidas qué dato va ahí (me avisas y lo conecto).
3. Copia esas filas y pégalas en la hoja **`Productos`** del Sheet (debajo del encabezado).
4. Listo: el técnico busca por nombre y el precio se toma solo desde la columna C. Él solo escribe la **cantidad usada**.

En la hoja `Config Técnico` puedes ajustar qué columnas se le muestran al técnico al buscar (por defecto: Producto y Precio).

---

## 5. Cómo trabaja el técnico

- **Generales** → sus casos pendientes (los que le derivaste). El más reciente arriba, emergencias marcadas.
- **Casos históricos** → los que ya cerró.
- **Buscar establecimiento** → ver casos por colegio.

Al abrir un caso lo ve igual que en el panel admin: info completa, quién lo subió, verificadores del encargado. Abajo, el estado **Pendiente**.

**Para cerrar** toca **Solucionado** → se abre el flujo:
1. **¿Usó materiales? Sí/No.** Si sí, busca productos del catálogo y pone cantidades (puede agregar varios; ve el total en pesos).
2. **Fotos/videos** del trabajo — cámara o galería, con recorte automático de videos a 15s y barra de progreso que bloquea el cierre hasta terminar de subir.
3. **GPS** — la app lo captura desde que abre el caso (en segundo plano), así al cerrar ya está listo y no hay que esperar. Si no está activo, avisa.
4. Guarda → el caso pasa a **SOLUCIONADO** en todas las apps, se calcula el tiempo de resolución, y se copia a su hoja con los materiales ordenados en columnas.

---

## 6. Contrato con el backend (referencia)

**GET**
- `?tecnico=NOMBRE` → `{ ok, reportes:[casos derivados a ese técnico], productos, configTecnico }`
- `?productos=1` → `{ ok, productos, columnas, configTecnico }`
- `?tecnicos=1` → `{ ok, tecnicos }`

**POST**
- `{ accion:"solucionarTecnico", encargado, reporteId, derivadoA, gps, verificadoresTecnico, materiales:[{producto,cantidad,precio,extra}], fechaSolucion, tsSolucion }`
- `{ accion:"subirArchivoTecnico", fileName, mime, data }` (verificadores del técnico)

El cierre marca SOLUCIONADO en la hoja del encargado y copia el caso a la hoja del técnico con materiales expandidos.

---

## 7. Notas

- El estado que el técnico ve es **Pendiente** para todo lo derivado a él hasta que lo cierra (aunque tú ya lo hayas visado/derivado). Al cerrar pasa a Solucionado en todo el ecosistema.
- Los materiales quedan en columnas (`Material N | Cant N | Precio N | Subtotal N`) — sumas por columna sin leer texto.
- El GPS se guarda como dato del cierre (coordenadas + precisión).
- Requiere permisos de cámara y ubicación en el navegador.
