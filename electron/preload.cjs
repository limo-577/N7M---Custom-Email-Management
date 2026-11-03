const { contextBridge, ipcRenderer } = require('electron');
function listener(channel, callback) {
  const receive = (_event, data) => callback(data);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}
contextBridge.exposeInMainWorld('emailManager', {
  getVaultStatus: () => ipcRenderer.invoke('vault-status'),
  setupVault: password => ipcRenderer.invoke('vault-setup', password),
  unlockVault: password => ipcRenderer.invoke('vault-unlock', password),
  lockVault: () => ipcRenderer.invoke('vault-lock'),
  changeVaultPassword: (currentPassword, newPassword) => ipcRenderer.invoke('vault-change-password', { currentPassword, newPassword }),
  readEntrySecrets: id => ipcRenderer.invoke('read-entry-secrets', { id }),
  copyCredential: (id, field) => ipcRenderer.invoke('copy-credential', { id, field }),
  loadEmailData: () => ipcRenderer.invoke('load-email-data'),
  importExcelFile: (requestId, buffer) => ipcRenderer.invoke('import-excel-file', { requestId, buffer }),
  cancelExcelImport: requestId => ipcRenderer.invoke('cancel-excel-import', requestId),
  mutateEmailData: operation => ipcRenderer.invoke('mutate-email-data', operation),
  openEntry: id => ipcRenderer.invoke('open-entry', { id }),
  copyText: text => ipcRenderer.invoke('copy-text', text),
  exportEmailData: ids => ipcRenderer.invoke('export-email-data', { ids }),
  openToolbar: () => ipcRenderer.invoke('open-toolbar'),
  closeToolbar: () => ipcRenderer.invoke('close-toolbar'),
  setToolbarAlwaysOnTop: value => ipcRenderer.invoke('set-toolbar-always-on-top', value),
  openMainWindow: () => ipcRenderer.invoke('open-main-window'),
  onEmailDataUpdated: callback => listener('email-data-updated', callback),
  onVaultLocked: callback => listener('vault-locked', callback)
});
