export function swallowError<T>(cb: () => T): T | null {
  try {
    const returnVal = cb();

    // @ts-expect-error-next-line: T might be a Promise; checking this way is way easier than alternatives
    if ('catch' in returnVal && typeof returnVal.catch === 'function') {
      return returnVal.catch(() => {});
    }
    return returnVal;
  } catch (_err) {}
  return null;
}
