const { app, BrowserWindow, dialog} = require('electron');
const path = require('path');
const PomodoroTray = require("./app/pomodoro");
const { Clockify } = require("./lib/clockify");
const settings = require('electron-settings');
const prompt = require("custom-electron-prompt");

let mainWindow = null;
const createMainWindow = () => {
  const is = { development: true }
  mainWindow = new BrowserWindow({
    backgroundColor: '#FFF',
    width: 300,
    height: 150,
    show: false,
    frame: false,
    fullscreenable: false,
    resizable: false,
    webPreferences: {
      devTools: is.development,
      nodeIntegration: true,
    }
  });

  if (is.development) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadURL(`file://${path.join(__dirname, '../../dist/index.html')}`);
  }
};

app.whenReady().then(async () => {
  createMainWindow()

  let apiKey = await settings.get('clockify.apiKey');
  if (!apiKey) {
    apiKey = await prompt({
      title: 'Clockify API Key',
      label: '<center>Enter your API Key from Clockify\'s <a href="https://app.clockify.me/user/settings" target="_blank">User Settings</a> page</center>',
      type: 'input',
      useHtmlLabel: true,
      alwaysOnTop: true,
      width: 480,
      height: 200,
    })

    if (apiKey) {
      await settings.set('clockify', { apiKey })
    } else {
      dialog.showMessageBoxSync({
        type: 'error',
        message: "A Clockify API Key is required.",
        detail: "The application will terminate. You will be prompted to enter the API key next time the app is started.",
        title: 'No Clockify API Key'
      })
      app.quit()
    }
  }

  const clockify = new Clockify(apiKey);

  const user = await clockify.whoami();
  const userId = await settings.get('user.id');
  if (user.id !== userId) {
    await settings.reset();
    await settings.set('user', user)
  }

  const pomodoroTray = new PomodoroTray(clockify);
  await pomodoroTray.start()
})

app.dock.hide();

