const { Tray, Menu, MenuItem, dialog, app } = require("electron");
const path = require("path");
const settings = require('electron-settings');
const prompt = require('custom-electron-prompt')
const _ = require('lodash');

class Pomodoro {
  constructor(clockify, refreshInterval = 5000) {
    this.tray = null;
    this.refreshInterval = refreshInterval;
    this.started = false;
    this.clockify = clockify;
  }

  start = async () => {
    this.started = true;
    await this.refreshMenu();

    this.trayTextUpdateInterval = setInterval(
      this.updateTrayText.bind(this),
      1000
    )

    this.menuRefreshInterval = setInterval(this.refreshMenu.bind(this), this.refreshInterval)
  };

  stop = () => {
    this.started = false;
    clearInterval(this.trayTextUpdateInterval);
    clearInterval(this.menuRefreshInterval);
  }

  async updateTrayText(force) {
    if (!this.started && !force) {
      return;
    }

    let title = ''

    const workspaceId = await settings.get('workspace.id')
    const userId = await settings.get('user.id')
    if (workspaceId && userId) {
      const entry = await this.clockify.getActiveTimeEntry(workspaceId, userId)
      if (entry) {
        const project = (await this.clockify.getProjects(workspaceId)).find(p => p.id === entry.projectId);
        const startDate = new Date(entry.timeInterval.start);
        title = ` ${toTimeString(Date.now() - startDate)} - ${project.clientName}`;
      }
    }

    this.tray.setTitle(title);
  }

  async getWorkspacesMenu() {
    const workspaces = await this.clockify.listWorkspaces();
    const workspacesMenu = new Menu();
    const workspaceSelectorCallback = async ({id, label: name}) => {
      await settings.set('workspace', {
        id, name
      })
      await this.refreshMenu();
    }
    const workspaceId = await settings.get('workspace.id')
    workspaces.forEach(
      workspace => workspacesMenu.append(
        new MenuItem({
          id: workspace.id,
          label: workspace.name,
          type: 'radio',
          click: workspaceSelectorCallback,
          checked: workspace.id === workspaceId
        })
      )
    )

    return workspacesMenu;
  }

  async appendProjects(menu) {
    const _this = this;
    const workspaceId = await settings.get('workspace.id');
    if (!workspaceId) {
      return;
    }

    const projects = await this.clockify.getProjects(workspaceId);
    const projectsByClient = _.groupBy(projects, 'clientName');

    const userId = await settings.get('user.id')
    if (userId) {
      const entry = await this.clockify.getActiveTimeEntry(workspaceId, userId);
      if (entry) {
        const activeEntryMenu = menu; //new Menu();

        const project = projects.find(p => p.id === entry.projectId) || {};
        const startDate = new Date(entry.timeInterval.start);
        const formattedStartDate = Date.now() - startDate > 1000 * 3600 * 12
          ? startDate.toLocaleString() : startDate.toLocaleTimeString();

        menu.append(new MenuItem({
          label: `${project.name || 'No project'} (${project.clientName || 'No client'}) - Started at ${formattedStartDate}`,
          enabled: false, submenu: undefined,
          toolTip: entry.description
        }));

        if (entry.description) {
          menu.append(new MenuItem({
            label: entry.description.replace(/&/g, '&&'), enabled: false, submenu: undefined,
          }));
        }

        menu.append(new MenuItem({
          label: entry.description ? 'Update description' : 'Add description',
          click: () => _this.updateDescription()
        }));

        const lastTimeEntries = await this.clockify.getLastTimeEntries(workspaceId, userId, project.id) || [];
        const descriptions = lastTimeEntries
          .map(({description}) => description)
          .filter(d => _.trim(d) && d !== entry.description);

        menu.append(new MenuItem({
          label: "Set Description",
          submenu: _.uniq(descriptions).map(d => ({
              label: d,
              click: () => _this.updateDescription(d)
          }))
        }))

        activeEntryMenu.append(new MenuItem({label: 'Stop Timer',
          async click() {
            await _this.stop();
            try {
              await _this.clockify.stopCurrentTimeEntry(workspaceId, userId);
            } catch (e) {
              dialog.showMessageBoxSync({
                type: 'error',
                message: e.message,
                detail: e.response ? JSON.stringify(e.response.data, undefined, 2) : undefined,
                title: 'Error starting new time entry.'
              })
            }
            await _this.refreshMenu(true);
            await _this.updateTrayText(true);
          }
        }));
        const startDateNearest30 = new Date(Math.round(startDate.getTime()/1800000)*1800000)
        const startDateNearest60 = new Date(startDateNearest30 - 1800000)
        activeEntryMenu.append(new MenuItem({
          label: 'Adjust Start Time', submenu: [
            {label: 'by -15m', click: () => _this.updateStartTime(new Date(startDate.getTime() - 15*60*1000))},
            {label: 'by -30m', click: () => _this.updateStartTime(new Date(startDate.getTime() - 30*60*1000))},
            {label: `to ${startDateNearest30.toLocaleTimeString()}`, click: () => _this.updateStartTime(startDateNearest30)},
            {label: `to ${startDateNearest60.toLocaleTimeString()}`, click: () => _this.updateStartTime(startDateNearest60)},
          ]
        }));
      }

      const latestProjects = _.take(
        _.uniqBy(
          await this.clockify.getLatestProjects(workspaceId, userId),
          'projectId'
        ),
        10
      ).map(
          ({projectId}) => projects.find(p => p.id === projectId)
      ).filter(x => !!x && x.id !== (entry || {}).projectId)

      menu.append(new MenuItem({
        type: 'separator'
      }))
      menu.append(new MenuItem({
        label: (await this.clockify.getActiveTimeEntry(workspaceId, userId)) ? 'Switch to' : 'Start', enabled: false
      }))

      latestProjects.forEach(
        ({id, name, clientName}) => menu.append(new MenuItem({
          id,
          label: `${name} (${clientName})`,
          async click() {
            await _this.stop();
            try {
              await _this.clockify.startTimeEntry(workspaceId, userId, id);
              await _this.start();
            } catch (e) {
              dialog.showMessageBoxSync({
                type: 'error',
                message: e.message,
                detail: e.response ? JSON.stringify(e.response.data, undefined, 2) : undefined,
                title: 'Error starting new time entry.'
              })
            }
          }
        }))
      )
     }
    menu.append(new MenuItem({ type: 'separator'}))

    const allProjectsMenu = new Menu();
    Object.keys(projectsByClient).forEach(
      client => allProjectsMenu.append(new MenuItem({
        submenu: Menu.buildFromTemplate(
          projectsByClient[client].map(project => ({
            id: project.id,
            label: project.name,
          }))
        ),
        label: client,
      }))
    )
    menu.append(new MenuItem({
      label: 'All Projects',
      submenu: allProjectsMenu
    }))
  }

  async refreshMenu(force) {
    if (!this.started && !force) {
      return;
    }

    const menu = new Menu();
    menu.append(new MenuItem({type: 'separator'}))
    await this.appendProjects(menu);
    menu.append(new MenuItem({
      label: 'Workspaces',
      submenu: await this.getWorkspacesMenu()
    }))
    menu.append(new MenuItem({type: 'separator'}))
    menu.append(new MenuItem({
      label: 'Exit',
      click: app.quit
    }));
    if (!this.tray) {
      this.tray = new Tray(path.join(__dirname, "../assets/tomatoTemplate.png"))
    }
    this.tray.setContextMenu(menu)
  }

  async updateDescription(description) {
    try {
      const workspaceId = await settings.get('workspace.id')
      const userId = await settings.get('user.id')

      const entry = await this.clockify.getActiveTimeEntry(workspaceId, userId);
      if (!entry) {
        return;
      }

      description = description || await prompt({
        title: 'Update Description',
        value: entry.description,
        label: ' ',
        type: 'input'
      })
      if (description !== null) {
        await this.clockify.updateActiveTimeEntry(workspaceId, userId, {
          description
        })
      }
    } catch (e) {
      dialog.showMessageBoxSync({
        type: 'error',
        message: e.message,
        detail: e.response ? JSON.stringify(e.response.data, undefined, 2) : undefined,
        title: 'Error updating time entry.'
      })
    }
  }
  async updateStartTime(start) {
    try {
      const workspaceId = await settings.get('workspace.id')
      const userId = await settings.get('user.id')

      const entry = await this.clockify.getActiveTimeEntry(workspaceId, userId);
      if (!entry) {
        return;
      }
      const previousEntries = await this.clockify.getLastTimeEntries(workspaceId, userId, null);
      const previousStart = new Date(entry.timeInterval.start);
      const stoppedEntry = previousEntries.find(e => e.timeInterval.end && Math.abs(new Date(e.timeInterval.end) - previousStart) < 1000);

      // Only adjust start times by more than 1 minute.
      if (Math.abs(previousStart - start) < 60*1000) {
        return;
      }
      if (start) {
        await this.clockify.updateActiveTimeEntry(workspaceId, userId, { start })
        stoppedEntry && await this.clockify.updateTimeEntry(workspaceId, stoppedEntry, { end: start })
      }
    } catch (e) {
      dialog.showMessageBoxSync({
        type: 'error',
        message: e.message,
        detail: e.response ? JSON.stringify(e.response.data, undefined, 2) : undefined,
        title: 'Error updating time entry.'
      })
    }
  }

}

module.exports = Pomodoro;

function toTimeString(d) {
  let s = '';
  d = Math.floor(d/1000);
  for (let m of [60, 60, 24]) {
    s = ":" + (100 + d % m).toFixed().slice(1) + s;
    d = Math.floor(d / m)
  }
  if (d > 0) {
    return `${d}${s}`
  }
  return s.slice(1);
}