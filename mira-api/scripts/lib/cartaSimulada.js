// M14: copia del generador de src/models/restaurantModel.js del frontend.
// Versión del archivo: cf493de. SHA-256 completo del modelo: 674848dc394ebbf9c2f26d6e27676563a094d26c65f2bcce327da881f40a1675
// Mantener coherencia con las muestras del frontend en test/fixtures/cartasFrontend.json.
function hashTexto(str) {
  const s = String(str ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}


// Palabras de ingredientes (minúsculas, sin tildes) para derivar flags del plato.
// Conservador a propósito: ante la duda se marca (mejor ocultar que arriesgar).
const CARNE = ['jamon', 'pollo', 'ternera', 'cerdo', 'pato', 'cordero', 'conejo', 'pavo', 'buey', 'entrecot', 'chuleton', 'solomillo', 'secreto', 'morcilla', 'chorizo', 'salchicha', 'frankfurt', 'salami', 'panceta', 'lomo', 'costilla', 'costillas', 'entrana', 'vacio', 'milanesa', 'escalope', 'codillo', 'butifarra', 'longaniza', 'cochinillo', 'lechazo', 'cabrito', 'pastor', 'carnitas', 'cochinita', 'asada'];
const PESCADO = ['atun', 'salmon', 'bacalao', 'merluza', 'lubina', 'dorada', 'trucha', 'rodaballo', 'rape', 'bonito', 'sardina', 'anchoa', 'lenguado', 'gallo', 'pez', 'pescado', 'ceviche', 'sashimi', 'nigiri', 'maki', 'chirashi', 'zarzuela'];
const MARISCO = ['gamba', 'gambon', 'langostino', 'mejillon', 'almeja', 'bogavante', 'ostra', 'percebe', 'percebes', 'calamar', 'pulpo', 'sepia', 'chipiron', 'berberecho', 'cigala', 'necora', 'vieira', 'zamburina', 'navaja', 'marisco', 'zarzuela'];
const LACTEOS = ['queso', 'leche', 'nata', 'mantequilla', 'manteca', 'yogur', 'yogourt', 'crema', 'bechamel', 'helado', 'batido', 'carbonara', 'tiramisu', 'mascarpone', 'panna', 'lasana', 'risotto', 'pizza', 'parmesano', 'flan', 'natilla', 'brownie', 'coulant', 'pastel', 'tarta'];
const HUEVO = ['huevo', 'tortilla', 'mayonesa', 'alioli', 'flan', 'natilla', 'rebozado', 'empanada', 'pisco', 'carbonara', 'tiramisu', 'brownie', 'coulant', 'pastel', 'tarta', 'crep', 'tempura'];
const GLUTEN = ['pan', 'harina', 'pasta', 'pizza', 'empanada', 'croqueta', 'rebozado', 'tempura', 'frito', 'frita', 'bunuelo', 'crep', 'galleta', 'tarta', 'pastel', 'bizcocho', 'bocadillo', 'bocatta', 'hamburguesa', 'canelon', 'lasana', 'fideua', 'fideos', 'tallarines', 'noodles', 'ramen', 'naan', 'focaccia', 'calzone', 'bruschetta', 'gyoza', 'dim sum', 'cuscus', 'seitan'];
const FRUTOS = ['pesto', 'turron', 'romesco', 'praline', 'nuez', 'nueces', 'almendra', 'avellana', 'pistacho', 'anacardo', 'pinon', 'cacahuete', 'frutos secos'];
const SOJA = ['soja', 'tofu', 'edamame', 'miso', 'tamari', 'teriyaki'];
// Platos ambiguos donde el nombre no basta: se asume la versión típica.
const OVERRIDES_PLATO = {
  paella: { vegano: false, vegetariano: false, alergenos: ['marisco'] },
  cesar: { vegano: false, vegetariano: false, alergenos: ['huevo', 'lactosa', 'pescado'] },
  'tres delicias': { vegano: false, vegetariano: false, alergenos: ['huevo'] },
};

function normalizarPlato(nombre) {
  return (nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Flags de un plato a partir de su nombre (heurística conservadora).
 * @returns {{ vegano:boolean, vegetariano:boolean, sinGluten:boolean, alergenos:string[] }}
 */
function flagsPlato(nombre) {
  const t = normalizarPlato(nombre);
  const tiene = (lista) => lista.some((k) => t.includes(k));
  const esCarnePescado = tiene(CARNE) || tiene(PESCADO) || tiene(MARISCO);
  const flags = {
    vegano: !esCarnePescado && !tiene(LACTEOS) && !tiene(HUEVO),
    vegetariano: !esCarnePescado,
    sinGluten: !tiene(GLUTEN),
    alergenos: [
      ...(tiene(GLUTEN) ? ['gluten'] : []),
      ...(tiene(LACTEOS) ? ['lactosa'] : []),
      ...(tiene(HUEVO) ? ['huevo'] : []),
      ...(tiene(FRUTOS) ? ['frutos_secos'] : []),
      ...(tiene(MARISCO) ? ['marisco'] : []),
      ...(tiene(PESCADO) ? ['pescado'] : []),
      ...(tiene(SOJA) ? ['soja'] : []),
    ],
  };
  for (const [clave, over] of Object.entries(OVERRIDES_PLATO)) {
    if (t.includes(clave)) {
      flags.vegano = over.vegano;
      flags.vegetariano = over.vegetariano;
      flags.alergenos = [...new Set([...flags.alergenos, ...over.alergenos])];
    }
  }
  return flags;
}


const DESCRIPCIONES_PLATO = [
  'Receta de la casa con producto fresco.',
  'Elaborado al momento, de los más pedidos.',
  'Clásico de la casa, para compartir o no.',
];
const CANTIDADES_PLATO = ['Ración', 'Media ración', '350 g', '250 g', '8 piezas', '6 piezas', 'Para compartir'];

/**
 * Carta libro del local: misma base que la carta plana (coherentes) con
 * descripción, cantidad y flags, en secciones Entrantes/Principales/Postres.
 * Determinista por id. Si no hay postre detectado, se añade el de la casa.
 */
function cartaLibro(restaurante) {
  const base = cartaDelLocal(restaurante).map((p) => {
    const h = hashTexto(`${restaurante.id}:${p.nombre}`);
    return {
      ...p,
      descripcion: DESCRIPCIONES_PLATO[h % DESCRIPCIONES_PLATO.length],
      cantidad: CANTIDADES_PLATO[h % CANTIDADES_PLATO.length],
      ...flagsPlato(p.nombre),
    };
  });
  const sinTildes = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const esPostre = (p) => /(dulce|tarta|helado|flan|chocolate|tiramis|panna|coulant|brownie|pastel|strudel|natilla|crema catalana|sorbete|mousse|postre|nutella|mel i mato|yogur)/.test(sinTildes(p.nombre));
  const postres = base.filter(esPostre);
  const resto = base.filter((p) => !esPostre(p));
  const corte = Math.max(1, Math.min(3, resto.length - 1));
  const secciones = [
    { titulo: 'Entrantes', platos: resto.slice(0, corte) },
    { titulo: 'Principales', platos: resto.slice(corte) },
    {
      titulo: 'Postres',
      platos:
        postres.length > 0
          ? postres
          : [{ nombre: 'Postre de la casa', precio: 6, descripcion: 'La sugerencia dulce del día.', cantidad: 'Individual', ...flagsPlato('Postre de la casa') }],
    },
  ];
  return { secciones: secciones.filter((s) => s.platos.length > 0) };
}


const CARTA_POR_COCINA = [
  { match: ['sushi', 'japon', 'japanese'], platos: ['Nigiri de salmón', 'Ramen', 'Chirashi', 'Gyoza', 'Maki de atún', 'Tempura', 'Sashimi variado', 'Misoshiru'] },
  { match: ['pizzeria', 'pizza'], platos: ['Pizza margarita', 'Pizza cuatro quesos', 'Calzone', 'Bruschetta', 'Focaccia'] },
  { match: ['crep'], platos: ['Crep de jamón y queso', 'Crep de setas', 'Crep de Nutella', 'Galleta bretona'] },
  { match: ['italian', 'pasta', 'tagliatella', 'trattoria'], platos: ['Carbonara', 'Lasaña', 'Risotto de setas', 'Tiramisú', 'Panna cotta', 'Ossobuco'] },
  { match: ['tapas', 'spanish', 'espa', 'mediterr', 'catalan', 'paella', 'arros'], platos: ['Paella', 'Jamón ibérico', 'Bravas', 'Pulpo a la gallega', 'Tortilla', 'Calçots', 'Gazpacho', 'Crema catalana'] },
  { match: ['frankfurt', 'german', 'deutsch', 'wurst'], platos: ['Salchicha alemana', 'Codillo', 'Ensalada de patata', 'Strudel'] },
  { match: ['argentine', 'argentin', 'milonga'], platos: ['Entrana', 'Vacío', 'Empanadas', 'Flan con dulce de leche'] },
  { match: ['peruvian', 'peru', 'ceviche'], platos: ['Ceviche', 'Lomo saltado', 'Causa limeña', 'Pisco sour'] },
  { match: ['mexican', 'taco'], platos: ['Tacos al pastor', 'Burrito', 'Quesadillas', 'Guacamole', 'Enchiladas', 'Nachos'] },
  { match: ['oriental', 'asiatico', 'asia', 'chinese', 'china', 'wok', 'canton'], platos: ['Pato laqueado', 'Dim sum', 'Arroz tres delicias', 'Tallarines', 'Rollitos'] },
  { match: ['thai', 'vietnam'], platos: ['Pad thai', 'Curry verde', 'Tom yum', 'Rollitos vietnamitas'] },
  { match: ['indian', 'india', 'curry'], platos: ['Pollo tikka masala', 'Curry de cordero', 'Naan', 'Biryani', 'Samosas'] },
  { match: ['mcdonald', 'fast food', 'american', 'diner', 'bocatta', 'sandwich', 'viena'], platos: ['Bocadillo completo', 'Hamburguesa clásica', 'Patatas', 'Nuggets', 'Ensalada César'] },
  { match: ['burger', 'hamburg'], platos: ['Hamburguesa doble', 'Cheeseburger', 'Patatas trufadas', 'Aros de cebolla'] },
  { match: ['marisqueria', 'seafood', 'marisc', 'pescad'], platos: ['Lubina a la espalda', 'Arroz con bogavante', 'Mejillones', 'Gambas al ajillo', 'Zarzuela'] },
  { match: ['asador', 'braseria', 'brass', 'brasa', 'steak', 'grill', 'parrilla', 'barbecue'], platos: ['Entrecot', 'Chuletón', 'Costillas', 'Pollo a la brasa', 'Secreto', 'Steak tartar'] },
  { match: ['taberna', 'bodega', 'bodegueta', 'celler'], platos: ['Tabla de quesos', 'Vermut de grifo', 'Anchoas', 'Mejillones en escabeche'] },
  { match: ['french', 'franc'], platos: ['Confit de pato', 'Sopa de cebolla', 'Steak frites'] },
  { match: ['greek', 'grieg'], platos: ['Musaka', 'Giros', 'Ensalada griega'] },
  { match: ['kebab', 'turk', 'leban', 'arab'], platos: ['Kebab mixto', 'Falafel', 'Hummus', 'Shawarma'] },
  { match: ['dessert', 'postre', 'helad', 'pastel', 'bakery', 'cake', 'ice cream', 'dolc', 'xocolat', 'chocolate'], platos: ['Tarta de queso', 'Coulant', 'Helado artesano', 'Brownie'] },
  { match: ['breakfast', 'brunch', 'caf', 'xurreria', 'churro'], platos: ['Brunch completo', 'Huevos benedict', 'Tostada con tomate', 'Churros', 'Café de especialidad'] },
  { match: ['wine', 'vino'], platos: ['Tabla de embutidos', 'Copa de la casa', 'Vermut'] },
];
const CARTA_GENERICA = ['Plato del día', 'Menú degustación', 'Entrante de la casa', 'Ensalada verde', 'Sopa del día', 'Postre de la casa'];

/**
 * Carta determinista del local (mismo id → misma carta): 6-8 platos de su
 * cocina con precios según su tramo (€ 6-14 · €€ 10-24 · €€€ 18-38).
 * @returns {{ nombre:string, precio:number }[]}
 */
function cartaDelLocal(restaurante) {
  const texto = (((restaurante.categorias || []).join(' ') + ' ' + (restaurante.nombre || '')))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const grupo = CARTA_POR_COCINA.find((g) => g.match.some((m) => texto.includes(m)));
  const base = grupo ? grupo.platos : CARTA_GENERICA;
  const [min, max] = restaurante.precio === '€' ? [6, 14] : restaurante.precio === '€€€' ? [18, 38] : [10, 24];
  const h = hashTexto(restaurante.id);
  const n = Math.min(base.length, 6 + (h % 3));
  const rot = h % base.length;
  const rango = max - min + 1;
  return Array.from({ length: n }, (_, i) => ({
    nombre: base[(rot + i) % base.length],
    precio: min + ((h >>> ((i * 2 + 3) % 29)) % rango),
  }));
}


module.exports = { cartaLibro, cartaDelLocal };
