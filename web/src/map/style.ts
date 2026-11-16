// Estilo "carta de exploração": pergaminho, traço de tinta sépia, mar hachurado, florestas em
// pontilhado e nomes em versalete espaçado. Dados vetoriais OpenStreetMap (esquema OpenMapTiles).
import type { StyleSpecification, Map as GlMap } from 'maplibre-gl';

export const INK = '#2B1D12';
export const PAPER = '#F3E5CB';
const SEPIA = '#9C785C';
const SEA = '#447D83';
const LAPIS = '#F9F0D8';

const TILES = import.meta.env.VITE_TILES_URL ?? 'https://tiles.openfreemap.org/planet';
const GLYPHS = import.meta.env.VITE_GLYPHS_URL ?? 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

const name = ['coalesce', ['get', 'name:latin'], ['get', 'name']] as any;
const z = (...stops: number[]) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops] as any;
const road = (id: string, classes: string[], color: string, width: any, extra: object = {}) => ({
  id, type: 'line' as const, source: 'osm', 'source-layer': 'transportation',
  filter: ['all', ['in', ['get', 'class'], ['literal', classes]], ['!=', ['get', 'brunnel'], 'tunnel']] as any,
  layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
  paint: { 'line-color': color, 'line-width': width },
  ...extra,
});

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      osm: { type: 'vector', url: TILES, attribution: '© OpenStreetMap · OpenFreeMap' },
    },
    layers: [
      { id: 'paper', type: 'background', paint: { 'background-color': PAPER } },

      // Terra: vegetação e parques em aguada verde-oliva com pontilhado de tinta.
      { id: 'wood', type: 'fill', source: 'osm', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'farmland']]],
        paint: { 'fill-color': '#C9C692', 'fill-opacity': 0.45 } },
      { id: 'wood-stipple', type: 'fill', source: 'osm', 'source-layer': 'landcover', minzoom: 9,
        filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-pattern': 'trees', 'fill-opacity': 0.55 } },
      { id: 'park', type: 'fill', source: 'osm', 'source-layer': 'park',
        paint: { 'fill-color': '#C3C48A', 'fill-opacity': 0.5 } },
      { id: 'park-stipple', type: 'fill', source: 'osm', 'source-layer': 'park', minzoom: 11,
        paint: { 'fill-pattern': 'trees', 'fill-opacity': 0.5 } },
      { id: 'sand', type: 'fill', source: 'osm', 'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'sand'], paint: { 'fill-pattern': 'stipple', 'fill-opacity': 0.6 } },

      // Água: aguada esverdeada, ondas desenhadas e contorno duplo de costa como nas cartas antigas.
      { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': SEA } },
      { id: 'water-waves', type: 'fill', source: 'osm', 'source-layer': 'water',
        paint: { 'fill-pattern': 'waves', 'fill-opacity': 0.5 } },
      { id: 'coast-glow', type: 'line', source: 'osm', 'source-layer': 'water',
        paint: { 'line-color': SEPIA, 'line-width': z(8, 3, 16, 9), 'line-opacity': 0.16, 'line-blur': 2 } },
      { id: 'coast', type: 'line', source: 'osm', 'source-layer': 'water',
        paint: { 'line-color': INK, 'line-width': z(6, 0.6, 16, 1.6), 'line-opacity': 0.85 } },
      { id: 'river', type: 'line', source: 'osm', 'source-layer': 'waterway',
        paint: { 'line-color': '#447D83', 'line-width': z(8, 0.6, 16, 3) } },

      { id: 'building', type: 'fill', source: 'osm', 'source-layer': 'building', minzoom: 14,
        paint: { 'fill-color': '#D7C5A8', 'fill-opacity': z(14, 0, 15, 0.85), 'fill-outline-color': SEPIA } },

      // Caminhos: trilhas pontilhadas, ruas como traço de pena, estradas reais em linha dupla.
      road('path', ['path', 'track'], SEPIA, z(13, 0.5, 18, 1.6), { minzoom: 14, layout: {}, paint: {
        'line-color': SEPIA, 'line-width': z(13, 0.5, 18, 1.6), 'line-dasharray': [1, 2.5] } }),
      road('street-case', ['minor', 'service'], SEPIA, z(12, 0.4, 14, 2.2, 18, 15), { minzoom: 12 }),
      road('street', ['minor', 'service'], '#F4EBD3', z(12, 0, 14, 1.2, 18, 12.5), { minzoom: 12 }),
      road('avenue-case', ['secondary', 'tertiary'], INK, z(9, 0.5, 14, 4, 18, 22)),
      road('avenue', ['secondary', 'tertiary'], '#F7EFD9', z(9, 0, 14, 2.6, 18, 19)),
      road('highway-case', ['motorway', 'trunk', 'primary'], INK, z(6, 0.8, 14, 5.5, 18, 28)),
      road('highway', ['motorway', 'trunk', 'primary'], '#EFD9A0', z(6, 0.2, 14, 3.6, 18, 24)),
      { id: 'rail', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 11,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': INK, 'line-width': 1.2, 'line-dasharray': [4, 3], 'line-opacity': 0.6 } },

      { id: 'border', type: 'line', source: 'osm', 'source-layer': 'boundary',
        filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#D8402A', 'line-width': z(3, 0.8, 10, 2), 'line-dasharray': [5, 2, 1, 2], 'line-opacity': 0.75 } },

      // Letreiros.
      { id: 'street-name', type: 'symbol', source: 'osm', 'source-layer': 'transportation_name', minzoom: 15,
        layout: { 'symbol-placement': 'line', 'text-field': name, 'text-font': ['Noto Sans Italic'],
          'text-size': z(15, 10, 18, 13), 'text-letter-spacing': 0.08 },
        paint: { 'text-color': SEPIA, 'text-halo-color': PAPER, 'text-halo-width': 1.4 } },
      { id: 'water-name', type: 'symbol', source: 'osm', 'source-layer': 'water_name',
        layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': z(4, 11, 14, 16),
          'text-letter-spacing': 0.3, 'text-max-width': 6 },
        paint: { 'text-color': LAPIS, 'text-halo-color': SEA, 'text-halo-width': 1.2, 'text-opacity': 0.85 } },
      { id: 'quarter', type: 'symbol', source: 'osm', 'source-layer': 'place', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter', 'village']]],
        layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': z(12, 10, 16, 13),
          'text-transform': 'uppercase', 'text-letter-spacing': 0.22, 'text-max-width': 7 },
        paint: { 'text-color': SEPIA, 'text-halo-color': PAPER, 'text-halo-width': 1.6 } },
      { id: 'town', type: 'symbol', source: 'osm', 'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': z(4, 11, 12, 20),
          'text-transform': 'uppercase', 'text-letter-spacing': 0.18, 'text-max-width': 7 },
        paint: { 'text-color': INK, 'text-halo-color': PAPER, 'text-halo-width': 2 } },
      { id: 'realm', type: 'symbol', source: 'osm', 'source-layer': 'place', maxzoom: 7,
        filter: ['==', ['get', 'class'], 'country'],
        layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': z(2, 11, 6, 20),
          'text-transform': 'uppercase', 'text-letter-spacing': 0.4, 'text-max-width': 6 },
        paint: { 'text-color': '#8A2A1B', 'text-halo-color': PAPER, 'text-halo-width': 2 } },
    ],
  };
}

// Texturas desenhadas em canvas na hora: nenhuma imagem para baixar.
function pattern(size: number, draw: (c: CanvasRenderingContext2D) => void) {
  const k = 2, cv = document.createElement('canvas');
  cv.width = cv.height = size * k;
  const c = cv.getContext('2d')!;
  c.scale(k, k);
  c.strokeStyle = c.fillStyle = INK;
  c.lineCap = 'round';
  draw(c);
  return { img: c.getImageData(0, 0, size * k, size * k), pixelRatio: k };
}

const PATTERNS: Record<string, () => ReturnType<typeof pattern>> = {
  waves: () => pattern(48, (c) => {
    c.lineWidth = 0.9; c.globalAlpha = 0.55; c.strokeStyle = '#3F5F6B';
    for (const [x, y] of [[4, 12], [28, 36]]) {
      c.beginPath(); c.moveTo(x, y);
      c.quadraticCurveTo(x + 4, y - 5, x + 8, y); c.quadraticCurveTo(x + 12, y - 5, x + 16, y);
      c.stroke();
    }
  }),
  trees: () => pattern(40, (c) => {
    c.lineWidth = 0.9; c.globalAlpha = 0.6; c.strokeStyle = '#4C5A2A';
    for (const [x, y] of [[9, 14], [29, 32]]) {
      c.beginPath(); c.arc(x, y - 4, 4, Math.PI * 0.9, Math.PI * 2.1); c.stroke();
      c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 4); c.stroke();
    }
  }),
  stipple: () => pattern(16, (c) => {
    c.globalAlpha = 0.5;
    for (const [x, y] of [[3, 4], [11, 9], [6, 13]]) { c.beginPath(); c.arc(x, y, 0.7, 0, 7); c.fill(); }
  }),
};

export function installPatterns(map: GlMap) {
  map.on('styleimagemissing', (e) => {
    const make = PATTERNS[e.id];
    if (!make || map.hasImage(e.id)) return;
    const { img, pixelRatio } = make();
    map.addImage(e.id, img, { pixelRatio });
  });
}
