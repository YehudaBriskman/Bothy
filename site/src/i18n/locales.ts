import { en, type Messages } from './en.ts';

/**
 * The locale registry: the single place `lang` and `dir` come from.
 *
 * To add Hebrew: write `he.ts` (a `Messages`), register it below with
 * `dir: 'rtl'`, and add 'he' to ENABLED_LOCALES. Routes are generated per
 * enabled locale (English at the root, others under `/<code>/`), every page
 * gets `lang`/`dir` on `<html>` from here, and `hreflang` alternates follow.
 * The stylesheet uses logical properties throughout, so nothing flips by hand.
 */

export type LocaleCode = 'en';
export type Direction = 'ltr' | 'rtl';

export interface Locale {
  code: LocaleCode;
  /** BCP 47 tag for `lang` and for `Intl`. */
  tag: string;
  dir: Direction;
  /** The locale's own name for itself, shown in the language switcher. */
  name: string;
  messages: Messages;
}

export const LOCALES: Record<LocaleCode, Locale> = {
  en: { code: 'en', tag: 'en', dir: 'ltr', name: 'English', messages: en },
};

export const DEFAULT_LOCALE: LocaleCode = 'en';
export const ENABLED_LOCALES: readonly LocaleCode[] = ['en'];

/** The URL prefix of a locale: none for the default, `/he` for Hebrew. */
export function localePrefix(code: LocaleCode): string {
  return code === DEFAULT_LOCALE ? '' : `/${code}`;
}
