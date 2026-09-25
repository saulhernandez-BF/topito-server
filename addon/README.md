# Topito para Google Docs y Sheets (complemento del dominio)

Mismo motor que Slack y el plugin de Figma (topito-server). Archivos:

- `Code.gs` — menú, barra lateral, selección, llamadas al server y fórmulas.
- `Sidebar.html` — barra lateral (Crear / Reescribir / Ortografía / Tropicalizar, marca, país, formato, 👍 ⚪ 👎 + motivo).
- `appsscript.json` — permisos mínimos (`documents.currentonly`, `spreadsheets.currentonly`, `script.external_request`, `script.container.ui`, `userinfo.email`).

## Qué puede hacer el equipo

| Dónde | Cómo |
|---|---|
| Docs y Sheets | Extensiones → Topito → Abrir Topito (barra lateral) · Reescribir / Ortografía / Tropicalizar selección |
| Barra lateral | Reemplazar selección, Insertar, Copiar; calificar 👍 ⚪ 👎 y decir qué falló |
| Sheets | **Cada celda →** procesa cada celda seleccionada y escribe el resultado a la derecha (Tropicalizar: CO y CL en dos columnas) |
| Fórmulas | `=TOPITO("headline lentes de sol"; "headline")` · `=TOPITO_REESCRIBIR(A2; "caption"; "benandfrank"; "cl")` · `=TOPITO_TROPICALIZAR(A2; "cl")` · 5º argumento = nº de opciones (1–4, en columna). Resultados en caché 6 h. |

## Instalación (una vez)

1. script.google.com → **Proyecto nuevo** "Topito para Docs y Sheets"; pega los 3 archivos (activa "Mostrar appsscript.json" en Configuración).
2. Configuración del proyecto → **Propiedades de la secuencia de comandos**:
   `TOPITO_SECRET` = el mismo valor que `TOPITO_SHEET_SECRET` en Render.
3. Probar: Implementar → **Probar implementaciones** → Complemento de editor → elige un Doc/Sheet de prueba.
4. Publicar para todo el dominio (Google Workspace Marketplace, visibilidad **Privada**):
   1. Configuración del proyecto → **Proyecto de Google Cloud** → cambiar a un proyecto estándar (crear uno en console.cloud.google.com, ej. `topito-addon`), y configurar su **Pantalla de consentimiento OAuth** como *Interna*.
   2. Implementar → **Nueva implementación** → tipo *Complemento* → versión.
   3. En el proyecto de Cloud: habilitar **Google Workspace Marketplace SDK** → *Configuración de la app*: visibilidad **Privada**, integración *Complemento de editor* (Docs y Sheets), ID de implementación y versión del paso 2, los mismos scopes. *Ficha de Play Store*: nombre, descripción, íconos (32/48/96/128 px), capturas, correo de soporte.
   4. Un **admin de Google Workspace** de B&F: admin.google.com → Apps → Google Workspace Marketplace apps → *Agregar app* → busca "Topito" (sección interna) → **Instalar para todo el dominio** (o para grupos). Sin admin, cada persona puede instalarlo desde el Marketplace en la sección de apps internas si el dominio lo permite.

Actualizar: pegar el código nuevo → Implementar → Administrar implementaciones → nueva versión → actualizar el número de versión en el Marketplace SDK.
