const id = process.argv[2] || '1EaXjXyKcNE8Zbrrzy9niC1NFWDGiZNqhD4_Ip-dGjsI';
fetch(`https://docs.google.com/spreadsheets/d/${id}/htmlview`)
  .then(r => r.text())
  .then(t => {
    const sheets = [...t.matchAll(/data-sheet-id="(\d+)"[^>]*aria-label="([^"]+)"/g)]
      .map(m => ({ gid: m[1], name: m[2] }));
    const uniq = {};
    sheets.forEach(s => { uniq[s.gid] = s.name; });
    Object.entries(uniq).forEach(([gid, name]) => console.log(gid, name));
  })
  .catch(e => console.error(e.message));
