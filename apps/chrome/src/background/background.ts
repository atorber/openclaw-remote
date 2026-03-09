/**
 * Service worker: open side panel when extension action is clicked.
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
