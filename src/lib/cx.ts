import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 拼接 className，忽略假值 */
export function cx(...xs: ClassValue[]): string {
  return twMerge(clsx(xs))
}
