# La mejor mentira

Juego social multijugador en tiempo real con Node.js, Express y Socket.IO.

## Ejecutar localmente
`npm install`
`npm start`
Abrir http://localhost:3000

## Publicar en Render
- Runtime: Node
- Build command: npm install
- Start command: npm start
- Health check: /health

## Reglas iniciales
- Mínimo 3 jugadores.
- Cada ronda el lector recibe una pregunta y no responde.
- Los jugadores rojos inventan una mentira; los azules responden con la verdad.
- El lector revisa las respuestas y acusa a quienes cree que mintieron.
- Mentiroso no descubierto: +2 puntos. Mentiroso descubierto: +1. Lector: +2 por cada rojo descubierto y -1 por cada azul acusado.

Las salas y partidas viven en memoria del servidor. Un reinicio del servicio finaliza las partidas activas; no elimina el código ni la aplicación.
