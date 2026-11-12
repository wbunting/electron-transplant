// Bridge for the traffic-light overlay page (sandboxed, context-isolated).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const CHANNEL = 'linux-compat:traffic-lights';
contextBridge.exposeInMainWorld('trafficLights', {
  action: (name, alternate) => ipcRenderer.send(`${CHANNEL}:action`, String(name), alternate === true),
  onState: (callback) => ipcRenderer.on(`${CHANNEL}:state`, (_event, state) => callback(state)),
});
