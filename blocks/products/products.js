import { createOptimizedPicture } from '../../scripts/aem.js';
import {
  filterProducts, getCurrentFilters, normalizeProduct, onFiltersChanged,
} from '../filter/filter.js';
import { getCurrentSort, onSortChanged, sortProductList } from '../sort/sort.js';
import { pdpUrl, rowSku } from '../../scripts/pdp.js';
import { createTryOnButton, readTryOnLink } from '../try-on-info/try-on-info.js';
 
const PAGE_SIZE = 6;
 
/**
* Read what the author wrote in the block table:
*
*   | Products      |                    |
*   | Source        | /products.json     |   <- the published sheet (a link or plain text)
*
* The old format still works: a single cell holding just the sheet path.
* The "Try the look" label + link come from the "Try On Info (button)" block (findTryOnLink).
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
 
  // Sheet path: from the Source row, otherwise the first link, otherwise the last cell's text
  const sourceCell = pick('source', 'path', 'data');
  const link = (sourceCell || block).querySelector('a[href]');
  let source = null;
  if (link) {
    source = link.getAttribute('href');
  } else if (sourceCell) {
    source = sourceCell.textContent.trim() || null;
  } else if (!Object.keys(keyed).length) {
    const cells = block.querySelectorAll(':scope > div > div');
    source = (cells.length ? cells[cells.length - 1] : block).textContent.trim() || null;
  }
 
  return { source };
}
 
/** label + link from the "Try On Info (button)" block in this section (or anywhere on the page) */
function findTryOnLink(block) {
  const source = block.closest('.section')?.querySelector('.try-on-info.button')
    || document.querySelector('.try-on-info.button');
  return readTryOnLink(source);
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
* The percentage is worked out from price and salePrice. With no salePrice there is no
* crossed-out price and no badge. `product.salePrice` is null unless the product is really
* on sale (a number below `price`).
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
* Visible text: "156 reviews". Accessible name: "156 reviews for <product>" (contains the
* visible text, WCAG 2.5.3). On click it only fires a `product-reviews-click` event, so the
* reviews feature can be added later without touching the card:
*   document.addEventListener('product-reviews-click', (e) => e.detail.id);
*/
function buildReviewsButton(product) {
  const count = product.reviews;
  const word = count === 1 ? 'review' : 'reviews';
  const label = `${count} ${word}`;
 
  // "206" + " reviews". On small screens only the number is shown (the word is hidden in
  // CSS); the accessible name below always says the full "206 reviews for <product>".
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
 
/**
* "★★★★★ 156 reviews". The stars are plain, non-focusable content (role="img" with a
* text label); the stars are filled up to the rating (4.5 = four and a half) in CSS through
* the --rating variable. The reviews count is a button. Returns null when there is neither.
*/
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
* One product card. Keyboard / reading order (it follows the DOM order, no tabindex needed):
*   1. image link  2. title link  3. reviews button (if any)  4. try-on button (if tryOn)
* Only the image and the title go to the product page (/prod-details?sku=<skuID>).
* Price and stars are plain text.
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
 
export default async function decorate(block) {
  const { source: path } = readConfig(block);
  block.textContent = '';
 
  let products = []; // every product in the sheet
  let filtered = []; // products matching the current filters, in the chosen sort order
  let filters = getCurrentFilters(); // catch up if the Filter block already ran
  let sortBy = getCurrentSort(); // catch up if the Sort block already ran
  let shown = PAGE_SIZE; // how many products are currently in the grid
  let loaded = false;
  let tryOnLink = null; // label + link from the Try On Info (button) block
 
  // Toolbar: "Showing 1-24 of 234 products" on the left. The Sort block sits on the same
  // row at the right (the page layout puts them in the same grid row). The text updates
  // by itself whenever the cards change (filters, sort, "View more").
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
 
  // Append only the newly revealed products (so cards above are not rebuilt
  // and their images don't reload) — used by "View more".
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