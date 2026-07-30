process.env.DATABASE_PATH='/private/tmp/claude-501/-Users-amiantos-Coding-lurker-dev/da133db0-60e3-45b6-81d0-e9a5238870e6/scratchpad/f.db';
process.env.SESSION_SECRET='probe';
async function main() {
  const { previewsEnabled } = await import('./server/services/linkFetch.js');
  delete process.env.LURKER_LINK_PREVIEWS;
  console.log('default (unset)      →', previewsEnabled() ? 'ENABLED' : 'disabled');
  process.env.LURKER_LINK_PREVIEWS = 'on';
  console.log('LURKER_LINK_PREVIEWS=on →', previewsEnabled() ? 'ENABLED' : 'disabled');
}
main();
