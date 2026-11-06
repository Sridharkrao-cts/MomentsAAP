/**
 * Filter block (single file: blocks/filter/filter.js)
 * ---------------------------------------------------------------
 * Renders Category / Size / Color / Price filters and PUBLISHES a
 * `filters-changed` event on `document`. It never touches product cards.
 *
 * Sections in this file:
 *   1. Filtering logic (pure functions, reusable)
 *   2. Shared state + events
 *   3. Product data loader (the only place that knows the JSON shape)
 *   4. Authoring config reader (DA.live table)
 *   5. UI builders
 *   6. decorate()  <- EDS calls this
 *
 * Product Cards can either:
 *   A) just listen:  document.addEventListener('filters-changed', (e) => e.detail)
 *   B) or import:    import { filterProducts, getCurrentFilters, onFiltersChanged } from '../filter/filter.js';
 */

/* ================================================================== */
/* 1. FILTERING LOGIC (pure: no DOM, no fetch)                         */
/*    inside a group = OR, between groups = AND, empty group = ignore */
/* ================================================================== */

export const PRICE_BOUNDS = { min: 0, max: 200 };

export function createDefaultFilters(bounds = PRICE_BOUNDS) {
  return { category: [], size: [], color: [], price: { min: bounds.min, max: bounds.max } };
}

/** "  Blue " -> "blue" (case and space insensitive matching) */
export const normalize = (value) => String(value ?? '').trim().toLowerCase();

/** "S, M, L" or ["S","M"] or "XL" -> ["S","M","L"] */
export function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function matchesGroup(selectedSet, productValue) {
  if (selectedSet.size === 0) return true; // nothing selected = no restriction
  return toList(productValue).some((v) => selectedSet.has(normalize(v)));
}

/**
 * @param {Array}  products  normalized products
 * @param {Object} filters   { category:[], size:[], color:[], price:{min,max} }
 * @returns {Array} products matching ALL active groups
 */
export function filterProducts(products, filters = {}) {
  const f = { ...createDefaultFilters(), ...filters };
  const toSet = (list) => new Set(toList(list).map(normalize));
  const categories = toSet(f.category);
  const sizes = toSet(f.size);
  const colors = toSet(f.color);
  const min = Number(f.price?.min ?? PRICE_BOUNDS.min);
  const max = Number(f.price?.max ?? PRICE_BOUNDS.max);

  return products.filter((product) => {
    const price = Number(product.effectivePrice ?? product.price); // sale price if any
    return (
      matchesGroup(categories, product.category)
      && matchesGroup(sizes, product.size)
      && matchesGroup(colors, product.color)
      && price >= min && price <= max // NaN price -> hidden
    );
  });
}

/** Number of active filters (for the badge and the Clear button). */
export function countActiveFilters(filters, bounds = PRICE_BOUNDS) {
  const selected = filters.category.length + filters.size.length + filters.color.length;
  const priceChanged = filters.price.min !== bounds.min || filters.price.max !== bounds.max;
  return selected + (priceChanged ? 1 : 0);
}

/* ================================================================== */
/* 2. SHARED STATE + EVENTS                                            */
/* ================================================================== */

export const EVENTS = {
  FILTERS_CHANGED: 'filters-changed', // Filter block -> everyone
  PRODUCTS_FILTERED: 'products-filtered', // Product Cards -> everyone (optional)
};

let currentFilters = createDefaultFilters();

/** Latest filters (a copy). Lets a block that loads late catch up. */
export function getCurrentFilters() {
  return structuredClone(currentFilters);
}

/** Remember the latest filters. */
export function updateFilterState(nextFilters) {
  currentFilters = structuredClone({ ...createDefaultFilters(), ...nextFilters });
  return getCurrentFilters();
}

/** Announce "filters changed" to the whole page. */
export function publishFilterChange(filters = currentFilters) {
  document.dispatchEvent(
    new CustomEvent(EVENTS.FILTERS_CHANGED, { detail: structuredClone(filters) }),
  );
}

/** Listen for changes. Returns a function that stops listening. */
export function onFiltersChanged(handler) {
  const listener = (event) => handler(event.detail);
  document.addEventListener(EVENTS.FILTERS_CHANGED, listener);
  return () => document.removeEventListener(EVENTS.FILTERS_CHANGED, listener);
}

/* ================================================================== */
/* 3. PRODUCT DATA (swap dummy -> production by changing the Source)   */
/* ================================================================== */

export const DEFAULT_SOURCE = '/services/products-sheet.json';
const cache = new Map();

/** TRUE / true / yes / y / 1 / x -> true. Empty, FALSE, anything else -> false. */
const toBoolean = (value) => (typeof value === 'boolean'
  ? value
  : ['true', 'yes', 'y', '1', 'x'].includes(String(value ?? '').trim().toLowerCase()));

const toNumber = (value) => parseFloat(String(value ?? '').replace(/[^0-9.]/g, '')); // "" -> NaN

/**
 * DA.live sheets look like { data: [ {col:"value"} ] } and every cell is a
 * STRING. Convert once here. Different column names? Edit only this function.
 *
 * Sheet columns: image, title, price, salePrice, url, category, size, color, ratings
 *                (optional: reviews = number of reviews, shown as "156 reviews")
 *                (optional: tryOn = TRUE/FALSE, shows the "Try On" button on the card)
 *   price          regular price
 *   salePrice      optional; empty cell = not on sale
 *   effectivePrice what the shopper pays (salePrice if on sale, else price).
 *                  The price slider filters on this one.
 */
export function normalizeProduct(raw, index = 0) {
  const price = toNumber(raw.price);
  const sale = toNumber(raw.salePrice ?? raw.saleprice ?? raw['sale-price']);
  const onSale = Number.isFinite(sale) && sale > 0 && (!Number.isFinite(price) || sale < price);
  const title = String(raw.title ?? raw.name ?? '').trim();
  const ratings = toNumber(raw.ratings ?? raw.rating);
  const reviews = toNumber(raw.reviews);

  return {
    ...raw,
    id: String(raw.id ?? raw.url ?? index),
    title,
    name: title, // alias, so older code using product.name still works
    image: String(raw.image ?? '').trim(),
    url: String(raw.url ?? '').trim(),
    category: String(raw.category ?? '').trim(),
    size: toList(raw.size ?? raw.sizes), // "S,M,L" -> ["S","M","L"]
    color: toList(raw.color ?? raw.colors),
    price, // regular price (NaN if empty)
    salePrice: onSale ? sale : null,
    effectivePrice: onSale ? sale : price,
    ratings: Number.isFinite(ratings) ? ratings : 0,
    reviews: Number.isFinite(reviews) ? reviews : 0,
    tryOn: toBoolean(raw.tryOn ?? raw.tryon ?? raw['try-on'] ?? raw['try on']),
  };
}

export function loadProducts(source = DEFAULT_SOURCE) {
  if (!cache.has(source)) {
    const request = fetch(source)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${source} (${response.status})`);
        return response.json();
      })
      .then((json) => (Array.isArray(json) ? json : (json.data ?? [])).map(normalizeProduct))
      .catch((error) => {
        cache.delete(source); // allow retry
        throw error;
      });
    cache.set(source, request);
  }
  return cache.get(source);
}

/* ================================================================== */
/* 4. UI CONSTANTS + HELPERS                                           */
/* ================================================================== */

const FALLBACK = {
  category: ['T-Shirts', 'Casual Shirts', 'Sweatshirts', 'Jackets'],
  size: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
  color: ['Black', 'White', 'Blue', 'Green', 'Red', 'Yellow', 'Orange'],
  bounds: { min: 0, max: 200 },
};

const SWATCHES = {
  black: '#111111',
  white: '#ffffff',
  blue: '#0b6bd3',
  green: '#4caf50',
  red: '#d6455d',
  yellow: '#e6d83a',
  orange: '#f58a1f',
};

const PRICE_STEP = 5;
const PUBLISH_DELAY_MS = 120;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  });
  node.append(...children);
  return node;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/** "Sliders" icon (three lines with knobs), drawn inline so no extra file is needed. */
function buildFilterIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'filter-toggle-icon');
  svg.setAttribute('aria-hidden', 'true');
  // One line per row, each with a round "knob": [knobX, y]
  [[8, 6], [16, 12], [10, 18]].forEach(([knobX, y]) => {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', 3);
    line.setAttribute('x2', 21);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    const knob = document.createElementNS(ns, 'circle');
    knob.setAttribute('cx', knobX);
    knob.setAttribute('cy', y);
    knob.setAttribute('r', 2.4);
    knob.setAttribute('fill', '#fff');
    svg.append(line, knob);
  });
  return svg;
}

/* ------------------------- authoring config ------------------------- */

function parseCellList(cell) {
  const items = [...cell.querySelectorAll('li')];
  if (items.length) return items.map((li) => li.textContent.trim()).filter(Boolean);
  const paragraphs = [...cell.querySelectorAll('p')];
  const text = paragraphs.length ? paragraphs.map((p) => p.textContent).join(',') : cell.textContent;
  return toList(text);
}

export function readConfig(block) {
  const rows = {};
  [...block.children].forEach((row) => {
    const [keyCell, valueCell] = row.children;
    if (keyCell && valueCell) rows[normalize(keyCell.textContent)] = valueCell;
  });

  const list = (key) => {
    const items = rows[key] ? parseCellList(rows[key]) : [];
    return items.length ? items : FALLBACK[key];
  };

  let bounds = { ...FALLBACK.bounds };
  const numbers = rows.price?.textContent.match(/\d+(\.\d+)?/g)?.map(Number);
  if (numbers?.length === 2 && numbers[0] < numbers[1]) bounds = { min: numbers[0], max: numbers[1] };

  return {
    category: list('category'),
    size: list('size'),
    color: list('color'),
    bounds,
    source: rows.source?.textContent.trim() || undefined,
  };
}

/* ---------------------------- UI builders --------------------------- */

/** variant: 'check' (box + count) | 'pill' (size button) | 'swatch' (color dot) */
function buildGroup({ name, title, options, variant }) {
  const optionNodes = options.map((option) => {
    const input = el('input', { type: 'checkbox', name, value: option });
    if (variant === 'pill') {
      return el('label', { class: 'filter-pill' }, input, el('span', { class: 'filter-pill-text', text: option }));
    }
    const label = el('label', { class: 'filter-option' }, input);
    if (variant === 'swatch') {
      const dot = el('span', { class: 'filter-swatch', 'aria-hidden': 'true' });
      dot.style.setProperty('--swatch', SWATCHES[normalize(option)] || normalize(option));
      label.append(dot);
    }
    label.append(el('span', { class: 'filter-label', text: option }));
    if (variant === 'check') label.append(el('span', { class: 'filter-count' }));
    return label;
  });

  return el(
    'fieldset',
    { class: `filter-group filter-group-${name}` },
    el('legend', { class: 'filter-title', text: title }),
    el('div', { class: `filter-options filter-options-${variant}` }, ...optionNodes),
  );
}

function buildPriceGroup(bounds) {
  const range = (name, value, label) => el('input', {
    type: 'range', name, min: bounds.min, max: bounds.max, step: PRICE_STEP, value, 'aria-label': label,
  });

  return el(
    'fieldset',
    { class: 'filter-group filter-group-price' },
    el('legend', { class: 'filter-title', text: 'Price' }),
    el(
      'div',
      { class: 'price-slider' },
      el('div', { class: 'price-track' }),
      range('price-min', bounds.min, 'Minimum price'),
      range('price-max', bounds.max, 'Maximum price'),
    ),
    el(
      'div',
      { class: 'price-values' },
      el('span', { class: 'price-value price-value-min' }),
      el('span', { class: 'price-value price-value-max' }),
    ),
  );
}

/** Reads the CURRENT checkbox/slider values from the form. */
export function getSelectedFilters(form) {
  const pick = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  const a = Number(form.elements['price-min'].value);
  const b = Number(form.elements['price-max'].value);
  return {
    category: pick('category'),
    size: pick('size'),
    color: pick('color'),
    price: { min: Math.min(a, b), max: Math.max(a, b) },
  };
}

function renderFilterState(block, filters, bounds) {
  const span = bounds.max - bounds.min;
  const slider = block.querySelector('.price-slider');
  slider.style.setProperty('--lo', `${((filters.price.min - bounds.min) / span) * 100}%`);
  slider.style.setProperty('--hi', `${((filters.price.max - bounds.min) / span) * 100}%`);

  block.querySelector('.price-value-min').textContent = `$${filters.price.min}`;
  block.querySelector('.price-value-max').textContent = `$${filters.price.max}`;
  slider.querySelector('[name="price-min"]').setAttribute('aria-valuetext', `$${filters.price.min}`);
  slider.querySelector('[name="price-max"]').setAttribute('aria-valuetext', `$${filters.price.max}`);

  const active = countActiveFilters(filters, bounds);
  block.querySelector('.filter-clear').disabled = active === 0;
  const badge = block.querySelector('.filter-badge');
  badge.textContent = active ? String(active) : '';
  badge.hidden = active === 0;
}

function applyCategoryCounts(block, products) {
  block.querySelectorAll('.filter-group-category .filter-option').forEach((label) => {
    const value = normalize(label.querySelector('input').value);
    const count = products.filter((p) => normalize(p.category) === value).length;
    label.querySelector('.filter-count').textContent = `(${count})`;
  });
}

/* ================================================================== */
/* 5. decorate(): called by EDS for every .filter block                */
/* ================================================================== */

export default async function decorate(block) {
  const config = readConfig(block);
  const { bounds } = config;
  block.textContent = ''; // remove authored table, rebuild as a form

  const form = el(
    'form',
    { class: 'filter-form', novalidate: true },
    buildGroup({ name: 'category', title: 'Categories', options: config.category, variant: 'check' }),
    buildGroup({ name: 'size', title: 'Size', options: config.size, variant: 'pill' }),
    buildGroup({ name: 'color', title: 'Color', options: config.color, variant: 'swatch' }),
    buildPriceGroup(bounds),
    el('button', { type: 'button', class: 'filter-clear', text: 'Clear all' }),
  );
  form.addEventListener('submit', (event) => event.preventDefault());

  // Mobile: a button opens/closes the panel (CSS hides the button on desktop).
  const panel = el('div', { class: 'filter-panel', id: 'filter-panel' }, form);
  const toggle = el(
    'button',
    { type: 'button', class: 'filter-toggle', 'aria-expanded': 'false', 'aria-controls': 'filter-panel' },
    el('span', { text: 'Filters' }),
    el('span', { class: 'filter-badge', hidden: true }),
    buildFilterIcon(),
  );
  toggle.addEventListener('click', () => {
    const open = block.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  block.append(toggle, panel);

  /** read -> remember -> announce */
  const apply = () => {
    const filters = getSelectedFilters(form);
    updateFilterState(filters);
    publishFilterChange(filters);
  };
  const applyDebounced = debounce(apply, PUBLISH_DELAY_MS);
  const refreshUI = () => renderFilterState(block, getSelectedFilters(form), bounds);

  form.addEventListener('change', (event) => {
    if (event.target.type !== 'checkbox') return;
    refreshUI();
    apply();
  });

  form.addEventListener('input', (event) => {
    if (event.target.type !== 'range') return;
    const minInput = form.elements['price-min'];
    const maxInput = form.elements['price-max'];
    if (event.target === minInput && Number(minInput.value) > Number(maxInput.value)) minInput.value = maxInput.value;
    if (event.target === maxInput && Number(maxInput.value) < Number(minInput.value)) maxInput.value = minInput.value;
    refreshUI();
    applyDebounced();
  });

  form.querySelector('.filter-clear').addEventListener('click', () => {
    form.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
    form.elements['price-min'].value = bounds.min;
    form.elements['price-max'].value = bounds.max;
    refreshUI();
    apply();
  });

  refreshUI();
  apply(); // first event, so a ready Product Cards block renders immediately

  // Counts are optional: filters still work if the data fails to load.
  loadProducts(config.source)
    .then((products) => applyCategoryCounts(block, products))
    .catch((error) => console.warn('[filter] counts unavailable:', error.message)); // eslint-disable-line no-console
}