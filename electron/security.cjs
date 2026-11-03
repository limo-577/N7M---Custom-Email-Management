const { pathToFileURL } = require('url');
const path = require('path');

function trustedPage(value, isDev) {
  try {
    const url = new URL(value);
    const expected = isDev ? new URL('http://127.0.0.1:5173/')
      : pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
    return url.protocol === expected.protocol && url.host === expected.host &&
      url.pathname === expected.pathname && !url.username && !url.password &&
      (!url.search || url.search === '?toolbar=1');
  } catch { return false; }
}
function trustedSender(event, windows, isDev) {
  return windows.some(win => win.webContents === event.sender) &&
    !!event.senderFrame && event.senderFrame === event.sender.mainFrame &&
    trustedPage(event.senderFrame.url, isDev);
}
module.exports = { trustedPage, trustedSender };
