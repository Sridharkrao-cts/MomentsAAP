import { createOptimizedPicture } from '../../scripts/aem.js';
import {
  filterProducts, getCurrentFilters, normalizeProduct, onFiltersChanged,
} from '../filter/filter.js';
import { getCurrentSort, onSortChanged, sortProductList } from '../sort/sort.js';

const PAGE_SIZE = 24;

/**
 * Read the data source path authored in the block.
 * Authors write the published spreadsheet path, e.g. `/products.json`
 * (either as a link, or as plain text in the last cell).
 */
function readSourcePath(block) {
  const link = block.querySelector('a[href]');
  if (link) return link.getAttribute('href');
  const cells = block.querySelectorAll(':scope > div > div');
  const text = (cells.length ? cells[cells.length - 1] : block).textContent.trim();
  return text || null;
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

/**
 * Turn a raw sheet row into a clean product using the same adapter as the Filter block.
 * Column names are matched case-insensitively and trimmed (`Image`, ` image ` -> `image`).
 * Sheet columns: image, title, price, salePrice, url, category, size, color, ratings
 * (optional: reviews, tryOn)
 */
function toProduct(row) {
  const clean = {};
  Object.entries(row).forEach(([key, value]) => {
    clean[key.trim().toLowerCase()] = typeof value === 'string' ? value.trim() : value;
  });
  return normalizeProduct(clean);
}

/** 49 -> "$49.00". Empty/invalid values give an empty string (nothing is shown). */
function money(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : '';
}

const HEART_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3'
  + 'c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5'
  + 'c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

const SPARKLE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<path d="M10 3l2 5.6L17.6 10.6 12 12.6 10 18.2 8 12.6 2.4 10.6 8 8.6z"/>'
  + '<path d="M19 14l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/></svg>';

/** Non-functional wishlist heart button shown on the card image. */
function buildWishlistButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'products-card-wishlist';
  btn.setAttribute('aria-label', 'Add to wishlist');
  btn.innerHTML = HEART_ICON;
  btn.addEventListener('click', (e) => e.preventDefault());
  return btn;
}

/** Non-functional "Try On" pill at the bottom of the image. Only built when `tryOn` is TRUE. */
function buildTryOnButton(title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'products-card-tryon';
  btn.setAttribute('aria-label', `Try on ${title}`);
  btn.innerHTML = `${SPARKLE_ICON}<span>Try On</span>`;
  btn.addEventListener('click', (e) => e.preventDefault());
  return btn;
}

/** Product picture, or a clean placeholder when the image is missing or fails to load. */
function buildImage(image, title) {
  const wrap = document.createElement('div');
  wrap.className = 'products-card-image';
  if (!image) {
    wrap.classList.add('is-empty');
    return wrap;
  }

  let node;
  try {
    node = createOptimizedPicture(image, title || '', false, [{ width: '750' }]);
  } catch (e) {
    // Value isn't a URL the optimizer accepts — use a plain img
    node = document.createElement('img');
    node.src = image;
    node.alt = title || '';
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
 * "$49.00  $65.00": the price the shopper pays in bold, the regular price in grey.
 * Not on sale (`salePrice` is null): only the regular price, in bold.
 */
function buildPrices(product) {
  const row = document.createElement('div');
  row.className = 'products-card-prices';

  const sale = money(product.salePrice);
  const regular = money(product.price);
  const main = sale || regular;
  if (main) {
    const mainEl = document.createElement('span');
    mainEl.className = 'products-card-price';
    mainEl.textContent = main;
    row.append(mainEl);
  }
  if (sale && regular) {
    const was = document.createElement('span');
    was.className = 'products-card-was';
    was.innerHTML = '<span class="products-sr-only">Regular price </span>';
    was.append(regular);
    row.append(was);
  }
  return row;
}

/**
 * "★★★★★ 156 reviews". The stars are filled up to the rating (4.5 = four and a half),
 * done in CSS through the --rating variable. Returns null when there is no rating.
 */
function buildRating(product) {
  const rating = Math.min(5, Math.max(0, product.ratings));
  if (!rating) return null;

  const row = document.createElement('div');
  row.className = 'products-card-rating';

  const stars = document.createElement('span');
  stars.className = 'products-card-stars';
  stars.setAttribute('role', 'img');
  stars.setAttribute('aria-label', `Rated ${rating} out of 5`);
  stars.style.setProperty('--rating', rating);
  stars.textContent = '★★★★★';
  row.append(stars);

  if (product.reviews > 0) {
    const reviews = document.createElement('span');
    reviews.className = 'products-card-reviews';
    reviews.textContent = `${product.reviews} ${product.reviews === 1 ? 'review' : 'reviews'}`;
    row.append(reviews);
  }
  return row;
}

function buildCard(product) {
  const titleText = product.title;

  const li = document.createElement('li');
  li.className = 'products-card';

  // Media: image with the heart (top right), plus the Try On pill (bottom) when tryOn is TRUE
  const media = document.createElement('div');
  media.className = 'products-card-media';
  media.append(buildImage(product.image, titleText), buildWishlistButton());
  if (product.tryOn) media.append(buildTryOnButton(titleText));

  // Body: title (its link covers the whole card), prices, rating
  const body = document.createElement('div');
  body.className = 'products-card-body';

  const title = document.createElement('p');
  title.className = 'products-card-title';
  const link = document.createElement('a');
  link.className = 'products-card-link';
  link.href = product.url || '#';
  link.textContent = titleText;
  title.append(link);

  body.append(title, buildPrices(product));
  const rating = buildRating(product);
  if (rating) body.append(rating);

  li.append(media, body);
  return li;
}

export default async function decorate(block) {
  const path = readSourcePath(block);
  block.textContent = '';

  let products = []; // every product in the sheet
  let filtered = []; // products matching the current filters, in the chosen sort order
  let filters = getCurrentFilters(); // catch up if the Filter block already ran
  let sortBy = getCurrentSort(); // catch up if the Sort block already ran
  let currentPage = 1;
  let loaded = false;

  // Toolbar: result count (the dropdown lives in the separate Sort block)
  const toolbar = document.createElement('div');
  toolbar.className = 'products-toolbar';

  const resultCount = document.createElement('p');
  resultCount.className = 'products-result-count';
  resultCount.setAttribute('aria-live', 'polite'); // screen readers announce filter results
  resultCount.textContent = 'Loading products…';

  toolbar.append(resultCount);

  const grid = document.createElement('ul');
  grid.className = 'products-grid';

  const pagination = document.createElement('nav');
  pagination.className = 'products-pagination';
  pagination.setAttribute('aria-label', 'Product pages');

  function render() {
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    currentPage = Math.min(currentPage, pageCount);

    const start = (currentPage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, total);
    const pageItems = filtered.slice(start, end);

    resultCount.textContent = total
      ? `Showing ${start + 1}-${end} of ${total} products`
      : 'No products found';

    if (total) {
      grid.replaceChildren(...pageItems.map(buildCard));
    } else {
      const empty = document.createElement('li');
      empty.className = 'products-empty';
      empty.textContent = 'No products match these filters. Try removing a filter.';
      grid.replaceChildren(empty);
    }

    pagination.replaceChildren();
    if (!total) return;

    const goTo = (page) => {
      currentPage = page;
      render();
      block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'products-page-btn products-page-prev';
    prev.innerHTML = '<span aria-hidden="true">‹</span> Previous';
    prev.disabled = currentPage === 1;
    prev.addEventListener('click', () => goTo(currentPage - 1));

    const info = document.createElement('span');
    info.className = 'products-page-info';
    info.textContent = `Page ${currentPage} of ${pageCount}`;

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'products-page-btn products-page-next';
    next.innerHTML = 'Next <span aria-hidden="true">›</span>';
    next.disabled = currentPage === pageCount;
    next.addEventListener('click', () => goTo(currentPage + 1));

    pagination.append(prev, info, next);
  }

  function applyFilters() {
    filtered = sortProductList(filterProducts(products, filters), sortBy);
    render();
  }

  block.append(toolbar, grid, pagination);

  // Subscribe BEFORE the data arrives, so a change during loading is not missed.
  onFiltersChanged((next) => {
    filters = next;
    currentPage = 1; // a new filter always starts again from page 1
    if (loaded) applyFilters();
  });

  onSortChanged((next) => {
    sortBy = next;
    currentPage = 1; // a new sort order always starts again from page 1
    if (loaded) applyFilters();
  });

  const rows = path ? await fetchProducts(path) : [];
  products = rows.map(toProduct);
  loaded = true;
  applyFilters();
}
