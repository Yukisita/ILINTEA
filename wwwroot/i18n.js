export const defaultLocale = 'ja';
export let locale = defaultLocale;
let defaults = {};
let messages = {};

async function loadCatalog(language) {
    const response = await fetch(new URL(`./i18n/${language}.json`, import.meta.url));
    if (!response.ok) throw new Error(`i18n/${language}.json: ${response.status}`);
    return response.json();
}

export async function initializeI18n() {
    defaults = await loadCatalog(defaultLocale);
    messages = defaults;
    locale = defaultLocale;
    const requested = new URLSearchParams(location.search).get('lang')?.replaceAll('_', '-').toLowerCase();
    if (requested && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(requested)) {
        for (const candidate of new Set([requested, requested.split('-')[0]])) {
            if (candidate === defaultLocale) break;
            try {
                Intl.getCanonicalLocales(candidate);
                messages = await loadCatalog(candidate);
                locale = candidate;
                break;
            } catch { /* Missing or unavailable languages fall back to Japanese. */ }
        }
    }
    applyTranslations();
}

export async function changeLanguage(language) {
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) throw new Error('Invalid locale');
    const catalog = language === defaultLocale ? defaults : await loadCatalog(language);
    const url = new URL(location.href);
    url.searchParams.set('lang', language);
    history.replaceState(history.state, '', url);
    messages = catalog;
    locale = language;
    applyTranslations();
}

function applyTranslations() {
    document.documentElement.lang = locale;
    for (const node of document.querySelectorAll('[data-i18n]'))
        node.textContent = t(node.dataset.i18n);
    for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
        for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`))
            node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
    }
    for (const link of document.querySelectorAll('.mode-tabs a, .brand'))
        link.href = withLanguage(link.href);
}

export function withLanguage(value) {
    const url = new URL(value, location.href);
    if (new URLSearchParams(location.search).has('lang')) url.searchParams.set('lang', locale);
    return url.href;
}

export function hasTranslation(key) {
    return Object.hasOwn(messages, key) || Object.hasOwn(defaults, key);
}

export function t(key, values = {}) {
    const text = messages[key] ?? defaults[key] ?? key;
    return text.replace(/\{([A-Za-z_]\w*)\}/g, (placeholder, name) =>
        Object.hasOwn(values, name) ? String(values[name] ?? '') : placeholder);
}
