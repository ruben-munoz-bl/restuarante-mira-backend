/**
 * fotos-places-lib: candidatos (sin foto, duplicadas, stock), emparejar el
 * local correcto en Places y decidir si una foto es válida.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../fotos-places-lib.js');

const base = (id, extra = {}) => ({ id, nombre: `Local ${id}`, coordenadas: { latitud: 41.39, longitud: 2.17 }, ...extra });

test('candidatos: sin foto, duplicadas y stock, en ese orden; salta las ya resueltas', () => {
  const lista = [
    base('a', { imagen_url: 'https://x/1.jpg', imagen_fuente: 'yelp' }),
    base('b', { imagen_url: 'https://x/rep.jpg', imagen_fuente: 'yelp' }),
    base('c', { imagen_url: 'https://x/rep.jpg', imagen_fuente: 'yelp' }),
    base('d', { imagen_url: null }),
    base('e', { imagen_url: 'https://pexels/1.jpg', imagen_fuente: 'pexels' }),
    base('f', { imagen_url: null, imagen_fuente: 'google_places' }),
  ];
  const c = lib.seleccionarCandidatos(lista);
  assert.deepEqual(c.map((r) => [r.id, r.motivo]), [['d', 'sin_foto'], ['b', 'duplicada'], ['c', 'duplicada'], ['e', 'stock']]);
  assert.deepEqual(lib.seleccionarCandidatos(lista, { incluirStock: false }).map((r) => r.id), ['d', 'b', 'c']);
  assert.ok(lib.seleccionarCandidatos(lista, { forzar: true }).some((r) => r.id === 'f'));
});

test('similitud de nombres ignora tildes, artículos y "restaurante"', () => {
  assert.equal(lib.similitudNombre('Restaurant El Celler de Gràcia', 'Celler de Gracia'), 1);
  assert.ok(lib.similitudNombre('Can Solé', 'Can Sole Barceloneta') >= 0.5);
  assert.ok(lib.similitudNombre('Sushi Born', 'Pizzeria Napoli') < 0.2);
});

test('emparejar: exige nombre parecido y cercanía; descarta homónimos lejanos', () => {
  const r = { nombre: 'Can Solé', coordenadas: { latitud: 41.3790, longitud: 2.1890 } };
  const places = [
    { id: 'lejos', displayName: { text: 'Can Solé' }, location: { latitude: 41.50, longitude: 2.30 } },
    { id: 'otro', displayName: { text: 'Bar Pepe' }, location: { latitude: 41.3791, longitude: 2.1891 } },
    { id: 'bueno', displayName: { text: 'Restaurant Can Solé' }, location: { latitude: 41.3792, longitude: 2.1893 } },
  ];
  assert.equal(lib.emparejarLugar(r, places).place.id, 'bueno');
  assert.equal(lib.emparejarLugar(r, [places[0], places[1]]), null);
});

test('veredicto de Gemini: lee JSON aunque venga en un bloque de código', () => {
  const v = lib.parsearVeredicto('```json\n{"categoria":"Fachada","personasPrimerPlano":false,"textoDominante":false,"calidad":4,"motivo":"exterior"}\n```');
  assert.deepEqual([v.categoria, v.calidad], ['fachada', 4]);
  assert.equal(lib.parsearVeredicto('no sé'), null);
});

test('foto válida: solo local o comida, sin personas ni texto, calidad ≥ 3', () => {
  const ok = { categoria: 'plato', personasPrimerPlano: false, textoDominante: false, calidad: 4 };
  assert.equal(lib.fotoValida(ok).ok, true);
  assert.equal(lib.fotoValida({ ...ok, personasPrimerPlano: true }).motivo, 'personas en primer plano');
  assert.equal(lib.fotoValida({ ...ok, textoDominante: true }).ok, false);
  assert.equal(lib.fotoValida({ ...ok, categoria: 'personas' }).ok, false);
  assert.equal(lib.fotoValida({ ...ok, categoria: 'logo' }).ok, false);
  assert.equal(lib.fotoValida({ ...ok, calidad: 2 }).ok, false);
  assert.equal(lib.fotoValida(null).ok, false);
});

test('elegir: prefiere fachada/interior a plato y luego la de más calidad', () => {
  const v = (categoria, calidad) => ({ veredicto: { categoria, calidad } });
  assert.equal(lib.elegirMejor([v('plato', 5), v('interior', 3), v('fachada', 3)]).veredicto.categoria, 'fachada');
  assert.equal(lib.elegirMejor([v('plato', 3), v('plato', 5)]).veredicto.calidad, 5);
  assert.equal(lib.elegirMejor([]), null);
});

test('prompt de generación: describe la cocina y prohíbe personas, texto y logos', () => {
  const p = lib.promptGeneracion({ categorias: ['Japonesa'], precio: '€€€', ciudad: 'Girona' });
  assert.match(p, /Japonesa/);
  assert.match(p, /Girona/);
  assert.match(p, /Sin personas/);
  assert.match(p, /sin texto/);
});

test('stock: loremflickr y Pexels por fuente o por dominio; Yelp no', () => {
  assert.equal(lib.esStock({ imagen_fuente: 'loremflickr', imagen_url: 'https://loremflickr.com/800/600/pizza?lock=1' }), true);
  assert.equal(lib.esStock({ imagen_fuente: null, imagen_url: 'https://loremflickr.com/800/600/tacos?lock=2' }), true);
  assert.equal(lib.esStock({ imagen_fuente: 'pexels', imagen_url: 'https://images.pexels.com/x.jpg' }), true);
  assert.equal(lib.esStock({ imagen_fuente: 'yelp', imagen_url: 'https://s3-media0.fl.yelpcdn.com/x.jpg' }), false);
  assert.equal(lib.esStock({ imagen_url: 'no es una url' }), false);
});

test('candidatos: las de loremflickr entran aunque sus URLs sean distintas (repetidas visualmente)', () => {
  const lista = [
    base('y', { imagen_url: 'https://s3-media0.fl.yelpcdn.com/1.jpg', imagen_fuente: 'yelp' }),
    base('l1', { imagen_url: 'https://loremflickr.com/800/600/pizza?lock=1', imagen_fuente: 'loremflickr' }),
    base('l2', { imagen_url: 'https://loremflickr.com/800/600/pizza?lock=2', imagen_fuente: 'loremflickr' }),
    base('s', { imagen_url: null }),
  ];
  assert.deepEqual(lib.seleccionarCandidatos(lista).map((r) => [r.id, r.motivo]), [['s', 'sin_foto'], ['l1', 'stock'], ['l2', 'stock']]);
});
