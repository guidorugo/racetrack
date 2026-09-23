/** Small DOM helpers: element lookup/creation, screens, toasts and confirm dialogs. */

import { t } from './i18n.js';

/**
 * @template {Element} T
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T}
 */
export function $(selector, root = document) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return /** @type {T} */ (node);
}

/** @param {string} selector @param {ParentNode} [root] @returns {HTMLElement[]} */
export function $all(selector, root = document) {
  return /** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)]);
}

/**
 * Creates an element. Text is always set via textContent (never innerHTML), so
 * player names can't inject markup.
 * @param {string} tag
 * @param {{ class?: string, text?: string, title?: string, attrs?: Record<string, string>, dataset?: Record<string, string> }} [props]
 * @param {Array<Node | string | null | undefined | false>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  Object.assign(node.dataset, props.dataset ?? {});
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** A coloured dot. @param {string} color */
export function swatch(color) {
  const node = el('span', { class: 'swatch', attrs: { 'aria-hidden': 'true' } });
  node.style.backgroundColor = color;
  return node;
}

/** Shows one `.screen` and hides the others. @param {string} id */
export function showScreen(id) {
  for (const screen of $all('main > .screen')) screen.hidden = screen.id !== id;
  window.scrollTo(0, 0);
}

/**
 * @param {string} message
 * @param {{ type?: 'info' | 'error' | 'success', timeoutMs?: number }} [options]
 */
export function toast(message, { type = 'info', timeoutMs = 4_000 } = {}) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const node = el('div', { class: `toast${type === 'info' ? '' : ` is-${type}`}`, text: message, attrs: { role: type === 'error' ? 'alert' : 'status' } });
  container.append(node);
  while (container.children.length > 4) container.firstElementChild?.remove();
  setTimeout(() => node.remove(), timeoutMs);
}

/**
 * Opens a modal dialog; resolves true if confirmed.
 * @param {{ title: string, text: string, okLabel?: string }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, text, okLabel = t('common.ok') }) {
  const dialog = /** @type {HTMLDialogElement} */ ($('#dialog-confirm'));
  $('[data-confirm-title]', dialog).textContent = title;
  $('[data-confirm-text]', dialog).textContent = text;
  $('[data-confirm-ok]', dialog).textContent = okLabel;
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.returnValue = '';
    openDialog(dialog);
  });
}

/** @param {HTMLDialogElement} dialog */
export function openDialog(dialog) {
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/** @param {HTMLDialogElement} dialog */
export function closeDialog(dialog) {
  if (!dialog.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

/** Shows or hides a form's error line. @param {HTMLElement} form @param {string | null} message */
export function setFormError(form, message) {
  const node = form.querySelector('.form-error');
  if (!node) return;
  node.textContent = message ?? '';
  /** @type {HTMLElement} */ (node).hidden = !message;
}
