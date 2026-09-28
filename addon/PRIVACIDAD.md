# Topito para Docs y Sheets — Privacidad y condiciones de uso

Complemento interno de Ben & Frank, disponible solo para cuentas @benandfrank.com.

## Qué datos usa
- **Texto seleccionado** en el documento u hoja activa (y el texto que escribes en la barra lateral), solo cuando pides una acción (crear, reescribir, ortografía, tropicalizar o una fórmula `=TOPITO()`).
- **Tu correo de Google Workspace**, para confirmar que perteneces al dominio y atribuir las calificaciones (👍 / ⚪ / 👎) que envíes.
- **Preferencias** (marca y país) guardadas en las propiedades de usuario de Google Apps Script.

El complemento solo tiene acceso al archivo abierto (`documents.currentonly` / `spreadsheets.currentonly`); no lee otros archivos de tu Drive.

## A dónde se envían
- Al servidor interno **topito-server**, que genera el copy con la API de Anthropic (Claude) y consulta la base de conocimiento de las marcas.
- Las calificaciones y comentarios se guardan en la base de datos interna de Topito (Supabase) para mejorar las respuestas.

No se venden ni comparten datos con terceros fuera de estos proveedores de procesamiento.

## Condiciones de uso
- Uso exclusivo para trabajo de Ben & Frank y Bombavista.
- El copy generado es una sugerencia: revísalo antes de publicarlo.
- No pegues datos personales de clientes ni información confidencial que no sea necesaria para el copy.

## Contacto y soporte
saul.hernandez@benandfrank.com
