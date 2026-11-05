# Rojo vs Azul

Shooter multijugador por equipos para jugar desde el celular (o la PC), en el navegador.
Estilo de dibujo animado, pistolas de agua, bombuchas y bombas de fuego.

- **Salas**: públicas (aparecen en la lista) o privadas (se entra con un código o un link `?sala=CODIGO`).
- **Modos**: DeathMatch (reaparición, gana el equipo con más bajas) y Guerra (por rondas, sin reaparecer).
- **Mapas**: Desierto, Galpón (con balcón alrededor) y Pueblo (terrazas, almacenes, autos, fuente).
- **Tienda**: armas de agua, granadas; se compra en la base de tu equipo.
- **Bots**: completan los equipos automáticamente (el creador de la sala puede apagarlo).

## Controles

- **Celular**: analógico izquierdo para moverte; botón rojo para disparar (arrastralo para apuntar);
  arrastrar en la mitad derecha gira la vista; ⬆️ saltar; 💦/🔥 tirar granada.
- **PC**: WASD para moverte, mouse para mirar (click para capturarlo), click o F para disparar,
  espacio para saltar, G granada, B tienda, Esc para soltar el mouse.

## Jugar en la red de casa

```
npm install
npm start
```

Abrí en los celulares la dirección `http://192.168.x.x:3030` que muestra la consola (misma red Wi-Fi).

## Publicar en internet (Render, gratis)

1. Subí esta carpeta a un repositorio de GitHub.
2. En https://render.com → **New** → **Blueprint** → elegí el repositorio (usa `render.yaml`).
3. Cuando termine, Render te da una dirección `https://rojo-vs-azul-xxxx.onrender.com`: compartila con tus amigos.

El plan gratis "se duerme" si nadie lo usa por 15 minutos: la primera entrada tarda ~1 minuto en despertar,
y al dormirse se cierran las salas abiertas.

## Dónde se ajusta el juego

- `public/map.js`: mapas, armas, granadas, velocidades, personajes.
- `public/world.js`: cómo se dibujan los mapas (texturas, objetos, cielo).
- `server.js`: reglas de la partida, salas y dificultad de los bots.
