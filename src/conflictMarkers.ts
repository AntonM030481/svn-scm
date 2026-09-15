const startMarker = /^<{7}(?: .*)?$/;
const separatorMarker = /^={7}$/;
const endMarker = /^>{7}(?: .*)?$/;

export function hasCompleteConflictMarkers(text: string): boolean {
  let state = 0;

  for (const line of text.split(/\r?\n/)) {
    if (state === 0 && startMarker.test(line)) {
      state = 1;
    } else if (state === 1 && separatorMarker.test(line)) {
      state = 2;
    } else if (state === 2 && endMarker.test(line)) {
      return true;
    } else if (startMarker.test(line)) {
      state = 1;
    }
  }

  return false;
}
