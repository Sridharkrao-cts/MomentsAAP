import { createOptimizedPicture } from '../../scripts/aem.js';
import {
  filterProducts, getCurrentFilters, normalizeProduct, onFiltersChanged,
} from '../filter/filter.js';
import { getCurrentSort, onSortChanged, sortProductList } from '../sort/sort.js';
import { pdpUrl, rowSku } from '../../scripts/pdp.js';
import { createTryOnButton, readTryOnLink } from '../try-on-info/try-on-info.js';

/*
 * Products block: one block, two modes (chosen in DA.live)
 *
 *   PLP:  | Products              |                               |
 *         | Source                | /services/products-sheet.json |
 *         -> filter + sort + toolbar + "Show me more" (3 columns)
 *
 *   PDP sections (Finish the Fit, Your Feed):
 *         | Products (collection) |                               |
 *         | Source                | /services/products-sheet.json |
 *         | Limit                 | 4                             |  optional, default 4
 *         | Filter                | collection=finish-the-fit     |  optional, column=value
 *         -> fixed list of cards (4 columns), no filter / sort / toolbar
 *
 * Both: image + name open the PDP (/prod-details?sku=<skuID>). "Try the look" shows only when
 * the PIM tryOn = TRUE; its label + link come from a "Try On Info (button)" block on the page.
 */

const PAGE_SIZE = 6; // PLP: cards per "Show me more"
const DEFAULT_LIMIT = 4; // collection: cards shown

/* ---------- shared ---------- */

/**
 * Read the block table. Rows: Source, Limit, Filter (any order, all optional except Source).
 * The old format still works: a single cell holding just the sheet path.
 */
function readConfig(block) {
  const keyed = {};
  [...block.children].forEach((row) => {
    const [keyCell, valueCell] = row.children;
    if (keyCell && valueCell) {
      keyed[keyCell.textContent.trim().toLowerCase().replace(/[^a-z]/g, '')] = valueCell;
    }
  });
  const pick = (...names) => names.map((name) => keyed[name]).find(Boolean);
  const text = (cell) => (cell ? cell.textContent.trim() : '');

  // Sheet path: from the Source row, otherwise the first link, otherwise the last cell's text
  const sourceCell = pick('source', 'path', 'data', 'jsonurl', 'json', 'url');
  const link = (sourceCell || block).querySelector('a[href]');
  let source = null;
  if (link) {
    source = link.getAttribute('href');
  } else if (sourceCell) {
    source = text(sourceCell) || null;
  } else if (!Object.keys(keyed).length) {
    const cells = block.querySelectorAll(':scope > div > div');
    source = (cells.length ? cells[cells.length - 1] : block).textContent.trim() || null;
  }

  return {
    source,
    limit: parseInt(text(pick('limit', 'count')), 10) || DEFAULT_LIMIT,
    filter: text(pick('filter')),
  };
}

/** Fetch the EDS sheet JSON and return its rows. */
async function fetchProducts(path) {
  try {
    const resp = await fetch(path);
    if (!resp.ok) return [];
    const json = await resp.json();
    // A single-sheet endpoint exposes `data`; a multi-sheet one nests under a sheet name.
    if (Array.isArray(json.data)) return json.data;
    const firstSheet = Object.values(json).find((v) => v && Array.isArray(v.data));
    return firstSheet ? firstSheet.data : [];
  } catch (e) {
    return [];
  }
}

/** label + link from the "Try On Info (button)" block in this section (or anywhere on the page) */
function findTryOnLink(block) {
  const source = block.closest('.section')?.querySelector('.try-on-info.button')
    || document.querySelector('.try-on-info.button');
  return readTryOnLink(source);
}

/* ---------- collection mode (PDP sections) ---------- */

const toKey = (text) => (text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** allows relative paths and http(s) urls only */
function safeUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed || trimmed === '#') return '';
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const parsed = new URL(trimmed, window.location.href);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (e) {
    return '';
  }
}

function formatPrice(raw) {
  const value = `${raw ?? ''}`.trim();
  if (!value) return '';
  const number = value.replace(/[$,\s]/g, '');
  if (/^\d+(\.\d+)?$/.test(number)) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(number));
  }
  return value;
}

/** case-insensitive column lookup, first matching name wins */
function column(row, ...names) {
  const key = Object.keys(row).find((k) => names.includes(toKey(k)));
  return key ? `${row[key] ?? ''}`.trim() : '';
}

/** "collection=finish-the-fit": keeps rows whose column has that value (comma-separated allowed) */
function matchesFilter(row, filter) {
  if (!filter || !filter.includes('=')) return true;
  const [name, value] = filter.split('=').map((s) => s.trim().toLowerCase());
  return column(row, toKey(name)).toLowerCase().split(',').map((v) => v.trim()).includes(value);
}

function toCollectionProduct(row) {
  const rating = parseFloat(column(row, 'ratings', 'rating'));
  const sku = rowSku(row);
  return {
    sku,
    image: safeUrl(column(row, 'image')),
    title: column(row, 'title'),
    price: formatPrice(column(row, 'price')),
    url: safeUrl(column(row, 'url')) || pdpUrl(sku),
    rating: Number.isFinite(rating) ? Math.min(Math.max(rating, 0), 5) : 0,
    reviews: parseInt(column(row, 'reviews', 'review'), 10) || 0,
    tryOn: column(row, 'tryon').toLowerCase() === 'true',
  };
}

function buildCollectionCard(product, tryOnLink) {
  const li = el('li', 'product-cards-item');

  // image links to the PDP too; hidden from Tab / screen readers so the
  // name is the single link announced per card
  const media = el(product.url ? 'a' : 'div', 'product-cards-image');
  if (product.url) {
    media.href = product.url;
    media.tabIndex = -1;
    media.setAttribute('aria-hidden', 'true');
  }
  if (product.image) {
    const img = el('img');
    img.src = product.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 320;
    img.height = 450;
    // broken image: keep the grey tile
    img.addEventListener('error', () => img.remove());
    media.append(img);
  }

  const info = el('div', 'product-cards-info');
  const name = el('h3', 'product-cards-name');
  if (product.url) {
    const a = el('a', '', product.title);
    a.href = product.url;
    name.append(a);
  } else {
    name.textContent = product.title;
  }
  info.append(name);

  if (product.price) info.append(el('p', 'product-cards-price', product.price));

  if (product.rating || product.reviews) {
    const rating = el('div', 'product-cards-rating');
    const stars = el('button', 'product-cards-stars');
    stars.type = 'button';
    stars.style.setProperty('--rating', product.rating);
    stars.setAttribute('aria-label', `${product.title}: rated ${product.rating} out of 5`);
    rating.append(stars);
    if (product.reviews) {
      const reviews = el('button', 'product-cards-reviews', `${product.reviews}`);
      reviews.type = 'button';
      reviews.setAttribute('aria-label', `${product.reviews} reviews for ${product.title}`);
      // mobile shows the count only, desktop adds "reviews"
      reviews.append(el('span', 'product-cards-reviews-label', ' reviews'));
      rating.append(reviews);
    }
    info.append(rating);
  }

  // PIM decides if the button shows; the Try On Info (button) block decides label + link
  if (product.tryOn && tryOnLink) {
    info.append(createTryOnButton(tryOnLink, 'product-cards-tryon', product));
  }

  li.append(media, info);
  return li;
}

async function decorateCollection(block, { source, limit, filter }) {
  const list = el('ul', 'product-cards-list');
  list.setAttribute('aria-busy', 'true');
  for (let i = 0; i < limit; i += 1) {
    const skeleton = el('li', 'product-cards-item product-cards-skeleton');
    skeleton.append(el('div', 'product-cards-image'));
    list.append(skeleton);
  }
  block.replaceChildren(list);

  try {
    if (!source) throw new Error('add a "Source" row with the JSON URL to the Products (collection) block');
    const rows = await fetchProducts(source);
    const tryOnLink = findTryOnLink(block);
    const products = rows
      .filter((row) => matchesFilter(row, filter))
      .map(toCollectionProduct)
      .filter((p) => p.title)
      .slice(0, limit);
    list.replaceChildren(...products.map((p) => buildCollectionCard(p, tryOnLink)));
    if (!products.length) block.classList.add('product-cards-empty');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('products (collection):', error);
    list.replaceChildren();
    block.classList.add('product-cards-empty');
  } finally {
    list.removeAttribute('aria-busy');
  }
}

/* ---------- PLP mode ---------- */

/**
* Turn a raw sheet row into a clean product using the same adapter as the Filter block.
* Column names are matched case-insensitively and trimmed (`Image`, ` image ` -> `image`).
* Sheet columns: skuID, image, title, price, salePrice, url, category, size, color, ratings
* (optional: reviews, tryOn)
* The image and title link to the PDP: /prod-details?sku=<skuID>. A real link in the
* `url` column is only used when the row has no skuID.
*/
function toProduct(row) {
  const clean = {};
  Object.entries(row).forEach(([key, value]) => {
    clean[key.trim().toLowerCase()] = typeof value === 'string' ? value.trim() : value;
  });
  const product = normalizeProduct(clean);
  const sheetUrl = product.url && product.url !== '#' ? product.url : '';
  product.sku = rowSku(row);
  product.url = pdpUrl(product.sku) || sheetUrl;
  return product;
}

/** 49 -> "$49.00". Empty/invalid values give an empty string (nothing is shown). */
function money(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : '';
}

/** The crossed-out price is shown without cents when it has none (95 -> "$95", 49.5 -> "$49.50"). */
function moneyShort(value) {
  if (!Number.isFinite(value)) return '';
  return Number.isInteger(value) ? `$${value}` : money(value);
}

/**
 * Discount in percent, worked out from the two prices: price 95, salePrice 76 -> 20.
 * Returns 0 (= show nothing) when the product is not on sale.
 */
function discountPercent(product) {
  const { price, salePrice } = product;
  if (!Number.isFinite(salePrice) || !Number.isFinite(price) || price <= 0 || salePrice >= price) return 0;
  return Math.round(((price - salePrice) / price) * 100);
}

/**
* Product picture, or a clean placeholder when the image is missing or fails to load.
* It has an empty alt on purpose: it sits inside the image link, and that link carries the
* product name (aria-label), so the name is read once and also survives a failed image.
*/
function buildImage(image) {
  const wrap = document.createElement('div');
  wrap.className = 'products-card-image';
  if (!image) {
    wrap.classList.add('is-empty');
    return wrap;
  }

  let node;
  try {
    node = createOptimizedPicture(image, '', false, [{ width: '750' }]);
  } catch (e) {
    // Value isn't a URL the optimizer accepts — use a plain img
    node = document.createElement('img');
    node.src = image;
    node.alt = '';
    node.loading = 'lazy';
  }
  const img = node.tagName === 'IMG' ? node : node.querySelector('img');
  if (img) {
    img.addEventListener('error', () => {
      node.remove();
      wrap.classList.add('is-empty');
    });
  }
  wrap.append(node);
  return wrap;
}

/**
 * Not on sale:  "$120.00"
 * On sale:      "$76.00"  "$95" (crossed out, grey)  "-20%" (yellow badge)
 */
function buildPrices(product) {
  const row = document.createElement('div');
  row.className = 'products-card-prices';

  const regular = moneyShort(product.price);
  const onSale = Number.isFinite(product.salePrice);

  if (onSale && regular) {
    const sale = document.createElement('span');
    sale.className = 'products-card-price';
    sale.innerHTML = '<span class="products-sr-only">Sale price </span>';
    sale.append(money(product.salePrice));

    const was = document.createElement('s');
    was.className = 'products-card-was';
    was.innerHTML = '<span class="products-sr-only">Regular price </span>';
    was.append(regular);

    row.append(sale, was);

    const percent = discountPercent(product);
    if (percent > 0) {
      const badge = document.createElement('span');
      badge.className = 'products-card-discount';
      badge.innerHTML = '<span class="products-sr-only">Discount </span>';
      badge.append(`-${percent}%`);
      row.append(badge);
    }
    return row;
  }

  // Not on sale (or no regular price to compare with): a single price
  const main = money(product.salePrice) || money(product.price);
  if (main) {
    const mainEl = document.createElement('span');
    mainEl.className = 'products-card-price';
    mainEl.textContent = main;
    row.append(mainEl);
  }
  return row;
}

/**
* "156 reviews" as a button (future: open the reviews). It never navigates to the product page.
* On click it only fires a `product-reviews-click` event:
*   document.addEventListener('product-reviews-click', (e) => e.detail.id);
*/
function buildReviewsButton(product) {
  const count = product.reviews;
  const word = count === 1 ? 'review' : 'reviews';
  const label = `${count} ${word}`;

  // "206" + " reviews". On small screens only the number is shown (the word is hidden in CSS)
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'products-card-reviews';
  const wordEl = document.createElement('span');
  wordEl.className = 'products-card-reviews-word';
  wordEl.textContent = ` ${word}`;
  btn.append(String(count), wordEl);
  if (product.title) btn.setAttribute('aria-label', `${label} for ${product.title}`);
  btn.addEventListener('click', () => {
    btn.dispatchEvent(new CustomEvent('product-reviews-click', {
      bubbles: true,
      detail: { id: product.id, title: product.title, reviews: count },
    }));
  });
  return btn;
}

/** "★★★★★ 156 reviews". Returns null when there is neither a rating nor reviews. */
function buildRating(product) {
  const rating = Math.min(5, Math.max(0, product.ratings));
  const hasReviews = product.reviews > 0;
  if (!rating && !hasReviews) return null;

  const row = document.createElement('div');
  row.className = 'products-card-rating';

  if (rating) {
    const stars = document.createElement('span');
    stars.className = 'products-card-stars';
    stars.setAttribute('role', 'img');
    stars.setAttribute('aria-label', `Rated ${rating} out of 5`);
    stars.style.setProperty('--rating', rating);
    stars.textContent = '★★★★★';
    row.append(stars);
  }

  if (hasReviews) row.append(buildReviewsButton(product));
  return row;
}

/**
* One PLP card. Keyboard order: image link, title link, reviews button, try-on button.
*/
function buildCard(product, tryOnLink) {
  const titleText = product.title;
  const href = product.url || '#';

  const li = document.createElement('li');
  li.className = 'products-card';

  // 1. Product image: link to the product page (named after the product)
  const media = document.createElement('div');
  media.className = 'products-card-media';
  const imageLink = document.createElement('a');
  imageLink.className = 'products-card-image-link';
  imageLink.href = href;
  if (titleText) imageLink.setAttribute('aria-label', titleText);
  imageLink.append(buildImage(product.image));
  media.append(imageLink);

  // Body, stacked: title (link), price (text), rating (stars text + reviews button)
  const body = document.createElement('div');
  body.className = 'products-card-body';

  // 2. Product title: link to the product page
  const title = document.createElement('p');
  title.className = 'products-card-title';
  const link = document.createElement('a');
  link.className = 'products-card-link';
  link.href = href;
  link.textContent = titleText;
  title.append(link);

  body.append(title, buildPrices(product));
  const rating = buildRating(product); // 3. reviews button lives in here
  if (rating) body.append(rating);

  li.append(media, body);

  // 4. Try-on button: PIM tryOn = TRUE decides if it shows,
  //    the "Try On Info (button)" block decides its label + link ("#" = try-on event)
  if (product.tryOn && tryOnLink) {
    li.append(createTryOnButton(tryOnLink, 'products-card-tryon', product));
  }
  return li;
}

async function decorateListing(block, { source: path }) {
  block.textContent = '';

  let products = []; // every product in the sheet
  let filtered = []; // products matching the current filters, in the chosen sort order
  let filters = getCurrentFilters(); // catch up if the Filter block already ran
  let sortBy = getCurrentSort(); // catch up if the Sort block already ran
  let shown = PAGE_SIZE; // how many products are currently in the grid
  let loaded = false;
  let tryOnLink = null; // label + link from the Try On Info (button) block

  // Toolbar: "Showing 1-24 of 234 products" (the Sort block sits on the same row)
  const toolbar = document.createElement('div');
  toolbar.className = 'products-toolbar';

  const resultCount = document.createElement('p');
  resultCount.className = 'products-result-count';
  resultCount.setAttribute('aria-live', 'polite'); // screen readers announce filter results
  resultCount.textContent = 'Loading products…';

  toolbar.append(resultCount);

  const grid = document.createElement('ul');
  grid.className = 'products-grid';

  // "Show me more" wrapper & non-clickable CTA setup
  const more = document.createElement('div');
  more.className = 'products-more';

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'products-more-btn';
  moreBtn.disabled = true; // Non-clickable / disabled state
  moreBtn.setAttribute('aria-disabled', 'true');

  // Chevron right icon SVG
  const chevronIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

  moreBtn.innerHTML = `<span>SHOW ME MORE</span>${chevronIcon}`;
  more.append(moreBtn);

  function updateToolbar() {
    const total = filtered.length;
    if (total) {
      // Check if the current screen width is mobile (< 900px)
      const isMobile = window.matchMedia('(max-width: 899px)').matches;
      const countText = `Showing 1-${Math.min(shown, total)}`;
      const totalText = `of ${total} products`;

      // 2 lines on mobile (<br>), single line on desktop (space)
      resultCount.innerHTML = isMobile
        ? `${countText}<br>${totalText}`
        : `${countText} ${totalText}`;
    } else {
      resultCount.textContent = 'No products found';
    }
    more.hidden = total === 0 || shown >= total;
  }
  window.addEventListener('resize', updateToolbar);

  // Rebuild the grid from the start (first load, filter and sort changes).
  function render() {
    const total = filtered.length;
    if (total) {
      grid.replaceChildren(...filtered.slice(0, shown).map((product) => buildCard(product, tryOnLink)));
    } else {
      const empty = document.createElement('li');
      empty.className = 'products-empty';
      empty.textContent = 'No products match these filters. Try removing a filter.';
      grid.replaceChildren(empty);
    }
    updateToolbar();
  }

  // Append only the newly revealed products (so cards above are not rebuilt)
  function renderMore() {
    const already = grid.querySelectorAll('.products-card').length;
    grid.append(...filtered.slice(already, shown).map((product) => buildCard(product, tryOnLink)));
    updateToolbar();
  }

  moreBtn.addEventListener('click', () => {
    shown = Math.min(shown + PAGE_SIZE, filtered.length);
    renderMore();
  });

  function applyFilters() {
    filtered = sortProductList(filterProducts(products, filters), sortBy);
    shown = PAGE_SIZE; // every filter/sort change starts again from the first page
    render();
  }

  block.append(toolbar, grid, more);

  // Subscribe BEFORE the data arrives, so a change during loading is not missed.
  onFiltersChanged((next) => {
    filters = next;
    if (loaded) applyFilters();
  });

  onSortChanged((next) => {
    sortBy = next;
    if (loaded) applyFilters();
  });

  const rows = path ? await fetchProducts(path) : [];
  tryOnLink = findTryOnLink(block);
  products = rows.map(toProduct);
  loaded = true;
  applyFilters();
}

/* ---------- entry ---------- */

export default async function decorate(block) {
  const config = readConfig(block);
  if (block.classList.contains('collection')) {
    await decorateCollection(block, config);
  } else {
    await decorateListing(block, config);
  }
}