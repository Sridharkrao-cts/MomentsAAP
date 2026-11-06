/**
 * Dynamic Filter block (single file: blocks/filter/filter.js)
 * ---------------------------------------------------------------
 * Content-driven filter generator reading directly from DA authoring table.
 * Publishes `filters-changed` events on `document`.
 */

/* ================================================================== */
/* 1. FILTERING LOGIC (dynamic, pure functions)                       */
/* ================================================================== */

export const normalize = (value) => String(value ?? '').trim().toLowerCase();

export function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function matchesGroup(selectedSet, productValue) {
  if (!selectedSet || selectedSet.size === 0) return true;
  return toList(productValue).some((v) => selectedSet.has(normalize(v)));
}

/**
 * Dynamically filters products based on whatever filter keys exist in `filters`.
 */
export function filterProducts(products, filters = {}) {
  return products.filter((product) => {
    return Object.entries(filters).every(([key, filterVal]) => {
      if (!filterVal) return true;

      // Handle Range/Price filters
      if (typeof filterVal === 'object' && ('min' in filterVal || 'max' in filterVal)) {
        const productVal = Number(product.effectivePrice ?? product[key] ?? product.price);
        const min = filterVal.min ?? -Infinity;
        const max = filterVal.max ?? Infinity;
        return productVal >= min && productVal <= max;
      }

      // Handle List/Set filters (Categories, Size, Color, Custom, etc.)
      const list = Array.isArray(filterVal) ? filterVal : [];
      if (list.length === 0) return true;
      const selectedSet = new Set(list.map(normalize));
      
      return matchesGroup(selectedSet, product[key]);
    });
  });
}

export function countActiveFilters(filters, boundsConfig = {}) {
  let count = 0;
  Object.entries(filters).forEach(([key, val]) => {
    if (Array.isArray(val)) {
      count += val.length;
    } else if (val && typeof val === 'object' && boundsConfig[key]) {
      const bounds = boundsConfig[key];
      if (val.min !== bounds.min || val.max !== bounds.max) count += 1;
    }
  });
  return count;
}

/* ================================================================== */
/* 2. SHARED STATE + EVENTS                                           */
/* ================================================================== */

export const EVENTS = {
  FILTERS_CHANGED: 'filters-changed',
};

let currentFilters = {};

export function getCurrentFilters() {
  return structuredClone(currentFilters);
}

export function updateFilterState(nextFilters) {
  currentFilters = structuredClone(nextFilters);
  return getCurrentFilters();
}

export function publishFilterChange(filters = currentFilters) {
  document.dispatchEvent(
    new CustomEvent(EVENTS.FILTERS_CHANGED, { detail: structuredClone(filters) }),
  );
}

export function onFiltersChanged(handler) {
  const listener = (event) => handler(event.detail);
  document.addEventListener(EVENTS.FILTERS_CHANGED, listener);
  return () => document.removeEventListener(EVENTS.FILTERS_CHANGED, listener);
}

/* ================================================================== */
/* 3. PRODUCT DATA LOADER                                            */
/* ================================================================== */

export const DEFAULT_SOURCE = '/products.json';
const cache = new Map();

const toBoolean = (value) => (typeof value === 'boolean'
  ? value
  : ['true', 'yes', 'y', '1', 'x'].includes(String(value ?? '').trim().toLowerCase()));

const toNumber = (value) => parseFloat(String(value ?? '').replace(/[^0-9.]/g, ''));

const toSizeLabel = (size) => String(size).trim().toUpperCase()
  .replace(/^(\d)XL$/, (_, count) => `${'X'.repeat(Number(count))}L`);

export function normalizeProduct(raw, index = 0) {
  const cols = {};
  Object.entries(raw).forEach(([key, value]) => {
    cols[key.trim().toLowerCase()] = typeof value === 'string' ? value.trim() : value;
  });

  const pick = (...names) => names
    .map((name) => cols[name])
    .find((value) => value !== undefined && value !== null && String(value).trim() !== '');

  const price = toNumber(pick('price'));
  const sale = toNumber(pick('saleprice', 'sale-price', 'sale price'));
  const onSale = Number.isFinite(sale) && sale > 0 && (!Number.isFinite(price) || sale < price);
  const title = String(pick('title', 'name') ?? '').trim();
  const ratings = toNumber(pick('ratings', 'rating'));
  const reviews = toNumber(pick('reviews', 'reviewcount'));
  const images = toList(pick('image', 'images'));

  return {
    ...raw,
    id: String(pick('id', 'skuid') ?? index),
    title,
    name: title,
    image: images[0] ?? '',
    images,
    url: String(pick('url') ?? '').trim(),
    category: String(pick('category', 'categories') ?? '').trim(),
    size: toList(pick('size', 'sizes')).map(toSizeLabel),
    color: toList(pick('color', 'colors', 'colour', 'colours')),
    price,
    salePrice: onSale ? sale : null,
    effectivePrice: onSale ? sale : price,
    ratings: Number.isFinite(ratings) ? ratings : 0,
    reviews: Number.isFinite(reviews) ? reviews : 0,
    tryOn: toBoolean(pick('tryon', 'tryonenabled', 'try-on', 'try on')),
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
        cache.delete(source);
        throw error;
      });
    cache.set(source, request);
  }
  return cache.get(source);
}

/* ================================================================== */
/* 4. UI CONSTANTS & DYNAMIC AUTHORING PARSER                        */
/* ================================================================== */

const SWATCHES = {
  black: '#111111',
  white: '#ffffff',
  blue: '#0b6bd3',
  green: '#4caf50',
  red: '#d6455d',
  yellow: '#e6d83a',
  orange: '#f58a1f',
};

const FILTER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5h16l-6.2 7.6V19l-3.6 1.8v-8.2z"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 15l6-6 6 6"/></svg>';

let groupCount = 0;
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

function parseCellList(cell) {
  const items = [...cell.querySelectorAll('li')];
  if (items.length) return items.map((li) => li.textContent.trim()).filter(Boolean);
  const paragraphs = [...cell.querySelectorAll('p')];
  const text = paragraphs.length ? paragraphs.map((p) => p.textContent).join(',') : cell.textContent;
  return toList(text);
}

/**
 * Dynamically parses ANY table rows authored in DA. live.
 */
export function readConfig(block) {
  const groups = [];
  let source = DEFAULT_SOURCE;

  [...block.children].forEach((row) => {
    const [keyCell, valueCell] = row.children;
    if (!keyCell || !valueCell) return;

    const rawTitle = keyCell.textContent.trim();
    const normKey = normalize(rawTitle);

    // Meta config row for data source
    if (normKey === 'source') {
      source = valueCell.textContent.trim() || DEFAULT_SOURCE;
      return;
    }

    const textValue = valueCell.textContent.trim();
    const rangeNumbers = textValue.match(/^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/);

    // Dynamic detection: Range field (e.g. 0-200) vs List Options field
    if (rangeNumbers) {
      const min = Number(rangeNumbers[1]);
      const max = Number(rangeNumbers[2]);
      groups.push({
        type: 'range',
        key: normKey.includes('price') ? 'price' : normKey,
        title: rawTitle,
        bounds: { min: Math.min(min, max), max: Math.max(min, max) },
      });
    } else {
      let variant = 'check';
      if (normKey.includes('size')) variant = 'pill';
      if (normKey.includes('color') || normKey.includes('colour')) variant = 'swatch';

      let key = normKey;
      if (normKey.includes('cat')) key = 'category';
      else if (normKey.includes('size')) key = 'size';
      else if (normKey.includes('color') || normKey.includes('colour')) key = 'color';

      groups.push({
        type: 'options',
        key,
        title: rawTitle,
        variant,
        options: parseCellList(valueCell),
      });
    }
  });

  return { groups, source };
}

/* ================================================================== */
/* 5. UI BUILDERS                                                     */
/* ================================================================== */

function buildSection({ key, title, body }) {
  groupCount += 1;
  const bodyId = `filter-group-body-${groupCount}`;
  const titleId = `filter-group-title-${groupCount}`;

  const button = el(
    'button',
    {
      type: 'button', class: 'filter-title', id: titleId, 'aria-expanded': 'true', 'aria-controls': bodyId,
    },
    el('span', { class: 'filter-title-text', text: title }),
  );
  button.insertAdjacentHTML('beforeend', CHEVRON_ICON);

  const content = el(
    'div',
    {
      class: 'filter-group-body', id: bodyId, role: 'group', 'aria-labelledby': titleId,
    },
    body,
  );

  const section = el(
    'div',
    { class: `filter-group filter-group-${key}` },
    el('h3', { class: 'filter-heading' }, button),
    content,
  );

  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
    content.hidden = open;
    section.classList.toggle('is-collapsed', open);
  });
  return section;
}

function buildOptions({ key, options, variant }) {
  const optionNodes = options.map((option) => {
    const input = el('input', { type: 'checkbox', name: key, value: option });
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
    
    // Only add count tag for standard check options (excluding swatches & pills)
    if (variant === 'check') {
      label.append(el('span', { class: 'filter-count' }));
    }
    return label;
  });

  return el('div', { class: `filter-options filter-options-${variant}` }, ...optionNodes);
}

function buildPriceSlider(key, bounds) {
  const range = (name, value, label) => el('input', {
    type: 'range', name: `${key}-${name}`, min: bounds.min, max: bounds.max, step: PRICE_STEP, value, 'aria-label': label,
  });

  return el(
    'div',
    { class: 'price-control' },
    el(
      'div',
      { class: 'price-slider' },
      el('div', { class: 'price-track' }),
      range('min', bounds.min, `Minimum ${key}`),
      range('max', bounds.max, `Maximum ${key}`),
    ),
    el(
      'div',
      { class: 'price-values', 'aria-hidden': 'true' },
      el('span', { class: `price-value ${key}-value-min` }),
      el('span', { class: `price-value ${key}-value-max` }),
    ),
  );
}

export function getSelectedFilters(form, groupsConfig) {
  const selected = {};

  groupsConfig.forEach((group) => {
    if (group.type === 'options') {
      selected[group.key] = [...form.querySelectorAll(`input[name="${group.key}"]:checked`)].map((i) => i.value);
    } else if (group.type === 'range') {
      const minVal = Number(form.elements[`${group.key}-min`]?.value ?? group.bounds.min);
      const maxVal = Number(form.elements[`${group.key}-max`]?.value ?? group.bounds.max);
      selected[group.key] = {
        min: Math.min(minVal, maxVal),
        max: Math.max(minVal, maxVal),
      };
    }
  });

  return selected;
}

function renderFilterState(block, filters, groupsConfig) {
  const boundsMap = {};

  groupsConfig.forEach((group) => {
    if (group.type === 'range') {
      boundsMap[group.key] = group.bounds;
      const rangeVal = filters[group.key];
      if (!rangeVal) return;

      const span = group.bounds.max - group.bounds.min || 1;
      const groupEl = block.querySelector(`.filter-group-${group.key}`);
      if (!groupEl) return;

      groupEl.style.setProperty('--lo', (rangeVal.min - group.bounds.min) / span);
      groupEl.style.setProperty('--hi', (rangeVal.max - group.bounds.min) / span);

      const minText = block.querySelector(`.${group.key}-value-min`);
      const maxText = block.querySelector(`.${group.key}-value-max`);
      if (minText) minText.textContent = group.key === 'price' ? `$${rangeVal.min}` : rangeVal.min;
      if (maxText) maxText.textContent = group.key === 'price' ? `$${rangeVal.max}` : rangeVal.max;
    }
  });

  const active = countActiveFilters(filters, boundsMap);
  const badge = block.querySelector('.filter-badge');
  if (badge) {
    badge.textContent = active ? String(active) : '';
    badge.hidden = active === 0;
  }
  const toggle = block.querySelector('.filter-toggle');
  if (toggle) {
    toggle.setAttribute('aria-label', active ? `Filters, ${active} selected` : 'Filters');
  }
}

function applyCounts(block, products, groupsConfig) {
  groupsConfig.forEach((group) => {
    // Skip range, pills, and swatches (color)
    if (group.type !== 'options' || group.variant !== 'check') return;

    block.querySelectorAll(`.filter-group-${group.key} .filter-option`).forEach((label) => {
      const input = label.querySelector('input');
      if (!input) return;
      const val = normalize(input.value);
      
      const count = products.filter((p) => {
        const itemVal = p[group.key];
        return toList(itemVal).some((v) => normalize(v) === val);
      }).length;

      const countSpan = label.querySelector('.filter-count');
      if (countSpan) countSpan.textContent = `(${count})`;
    });
  });
}
/* ================================================================== */
/* 6. decorate(): dynamic authoring renderer                          */
/* ================================================================== */

export default async function decorate(block) {
  const config = readConfig(block);
  block.textContent = ''; // Clear authored table

  const sectionElements = config.groups.map((group) => {
    let body;
    if (group.type === 'options') {
      body = buildOptions({ key: group.key, options: group.options, variant: group.variant });
    } else if (group.type === 'range') {
      body = buildPriceSlider(group.key, group.bounds);
    }
    return buildSection({ key: group.key, title: group.title, body });
  });

  const form = el('form', { class: 'filter-form', novalidate: true, autocomplete: 'off' }, ...sectionElements);
  form.addEventListener('submit', (event) => event.preventDefault());

  const panel = el('div', { class: 'filter-panel', id: 'filter-panel' }, form);
  const toggle = el(
    'button',
    {
      type: 'button',
      class: 'filter-toggle',
      'aria-label': 'Filters',
      'aria-expanded': 'false',
      'aria-controls': 'filter-panel',
    },
    el('span', { class: 'filter-badge', hidden: true }),
  );
  toggle.insertAdjacentHTML('afterbegin', FILTER_ICON);
  toggle.addEventListener('click', () => {
    const open = block.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  block.append(toggle, panel);

  const apply = () => {
    const filters = getSelectedFilters(form, config.groups);
    updateFilterState(filters);
    publishFilterChange(filters);
  };
  const applyDebounced = debounce(apply, PUBLISH_DELAY_MS);
  const refreshUI = () => renderFilterState(block, getSelectedFilters(form, config.groups), config.groups);

  form.addEventListener('change', (event) => {
    if (event.target.type !== 'checkbox') return;
    refreshUI();
    apply();
  });

  form.addEventListener('input', (event) => {
    if (event.target.type !== 'range') return;
    const name = event.target.name;
    const key = name.replace(/-(min|max)$/, '');
    const minInput = form.elements[`${key}-min`];
    const maxInput = form.elements[`${key}-max`];

    if (minInput && maxInput) {
      if (event.target === minInput && Number(minInput.value) > Number(maxInput.value)) {
        minInput.value = maxInput.value;
      }
      if (event.target === maxInput && Number(maxInput.value) < Number(minInput.value)) {
        maxInput.value = minInput.value;
      }
    }
    refreshUI();
    applyDebounced();
  });

  refreshUI();
  apply();

  loadProducts(config.source)
    .then((products) => applyCounts(block, products, config.groups))
    .catch((error) => console.warn('[filter] counts unavailable:', error.message));
}