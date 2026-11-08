// Small glob for ignore lists: `**` any depth, `*` and `?` inside one path segment. Matched against POSIX relative paths.
const cache = new Map();

export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } // `**/` = zero or more directories
        else if (re.endsWith('/')) { re = re.slice(0, -1) + '(?:/.*)?'; } // `x/**` = x itself and everything below
        else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp(`^${re}$`);
  cache.set(glob, rx);
  return rx;
}

export function matcher(globs) {
  const list = (globs || []).map(globToRegExp);
  return (rel) => list.some((rx) => rx.test(rel));
}
