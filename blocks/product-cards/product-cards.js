/*
* Product Cards block
* Product cards from a spreadsheet published as JSON (PIM data).
*
* Authoring:
*   | Product Cards |                           |
*   | Source        | /products.json            |   required
*   | Limit         | 4                         |   optional, default 4
*   | Filter        | collection=finish-the-fit |   optional, column=value
*
* Try the look button: label + link come from a "Try On Info (button)" block in the
* same section. It shows only on products whose PIM tryOn = TRUE.
*
* Columns used: skuID | image | title | price | url | ratings | reviews | tryOn | collection
* Image and name both open the PDP (/prod-details?sku=<skuID>).
* Rating / reviews buttons: click handlers come with the reviews integration.
*/
 
import { createTryOnButton, readTryOnLink } from '../try-on-info/try-on-info.js';
 
const DEFAULT_LIMIT = 4;
 
// PDP link: /prod-details?sku=<skuID>, so match these to the PDP block
const PDP_PATH = '/prod-details';
const PDP_PARAM = 'sku';
 
const toKey = (text) => (text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
 
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
 
function readConfig(block) {
  const config = {};
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    const valueCell = cells[cells.length - 1];
    if (!valueCell) return;
    const a = valueCell.querySelector('a[href]');
    const value = a ? a.getAttribute('href') : valueCell.textContent.trim();
    const key = cells.length > 1 ? toKey(cells[0].textContent) : '';
    if (key) config[key] = value;
    else if (/\.json(\?|#|$)/i.test(value)) config['json-url'] = value;
  });
  return config;
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
 
/** PDP link built from the skuID column */
function pdpUrl(sku) {
  return sku ? `${PDP_PATH}?${PDP_PARAM}=${encodeURIComponent(sku)}` : '';
}
 
function toProduct(row) {
  const rating = parseFloat(column(row, 'ratings', 'rating'));
  const sku = column(row, 'skuid', 'sku');
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
 
async function loadRows(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} returned ${resp.status}`);
  const json = await resp.json();
  if (Array.isArray(json.data)) return json.data;
  // multi-sheet workbook: use the first sheet
  const names = json[':names'] || Object.keys(json).filter((k) => !k.startsWith(':'));
  return (names.length && json[names[0]] && json[names[0]].data) || [];
}
 
/** label + link from the "Try On Info (button)" block in this section (or anywhere on the page) */
function findTryOnLink(block) {
  const source = block.closest('.section')?.querySelector('.try-on-info.button')
    || document.querySelector('.try-on-info.button');
  return readTryOnLink(source);
}
 
function buildCard(product, tryOnLink) {
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
 
export default async function decorate(block) {
  const config = readConfig(block);
  const url = config['json-url'] || config.json || config.url || config.source;
  const limit = parseInt(config.limit || config.count, 10) || DEFAULT_LIMIT;
 
  const list = el('ul', 'product-cards-list');
  list.setAttribute('aria-busy', 'true');
  for (let i = 0; i < limit; i += 1) {
    const skeleton = el('li', 'product-cards-item product-cards-skeleton');
    skeleton.append(el('div', 'product-cards-image'));
    list.append(skeleton);
  }
  block.replaceChildren(list);
 
  try {
    if (!url) throw new Error('add a "Source" row with the JSON URL to the Product Cards block');
    const rows = await loadRows(url);
    const tryOnLink = findTryOnLink(block);
    const products = rows
      .filter((row) => matchesFilter(row, config.filter))
      .map(toProduct)
      .filter((p) => p.title)
      .slice(0, limit);
    list.replaceChildren(...products.map((p) => buildCard(p, tryOnLink)));
    if (!products.length) block.classList.add('product-cards-empty');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('product-cards:', error);
    list.replaceChildren();
    block.classList.add('product-cards-empty');
  } finally {
    list.removeAttribute('aria-busy');
  }
}