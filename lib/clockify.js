const { randomUUID } = require('crypto');
const axios = require('axios');
const _ = require('lodash')
const {dialog} = require("electron");

class Cache {
  constructor(ttl = 300) {
    this.internal = {};
    this.ttl = ttl;
  }

  version(key) {
    const value = this.internal[key];
    return value ? value[0] : undefined;
  }
  get(key, version) {
    const value = this.internal[key];
    return value && (!version || version === value[0]) ?
      value[1] : undefined;
  }

  compute(key, fn, ttl, version) {
    try {
      const value = this.internal[key];
      if (value && (!version || version === value[0])) {
        return value[1]
      }

      const newValueResolvable = fn(key);
      Promise.resolve(newValueResolvable).then(
        newValue => {
          // set this value only if it hasn't been updated since
          if (this.version(key) === (value ? value[0] : undefined)) {
            this.set(key, newValue, ttl)
          }
        }
      ).catch((e) => {
        console.log(e)
      });
      return newValueResolvable;
    } catch (e) {
      console.log('Error in compute', e)
    }
  }

  set(key, value, ttl) {
    const version = randomUUID().toString();
    clearTimeout((this.internal[key] || [])[2])
    this.internal[key] = [
      version,
      value,
      setTimeout(() => {
        if (this.version(key) === version) {
          delete this.internal[key];
        }
      }, (ttl || this.ttl) * 1000)
    ]
  }
}

const store = new Cache(30)

class Clockify {
  constructor(apiKey) {
    this.client = axios.create({
      headers: {
        'x-api-key': apiKey
      }
    });

  }

  async listWorkspaces() {
    return store.compute('workspaces', async () => {
      const response = await this.client.get('https://api.clockify.me/api/v1/workspaces');
      return response.data;
    }, 300);
  }

  async getProjects(workspaceId) {
    return store.compute(`projects:${workspaceId}`, async () => {
      const response = await this.client.get(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/projects?page-size=500`);
      return response.data;
    }, 300)
  }

  async getLatestProjects(workspaceId, userId) {
    return store.compute(`projects:${workspaceId}:${userId}`, async () => {
      const response = await this.client.get(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/user/${userId}/time-entries?page-size=200`);
      return response.data;
    }, 300)
  }

  async getActiveTimeEntry(workspaceId, userId, bypassCache) {
    return store.compute(`currentProject:${workspaceId}:${userId}`, async () => {
      const response = await this.client.get(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/user/${userId}/time-entries?page-size=1&in-progress=true`);
      return response.data[0];
    }, 5, bypassCache ? randomUUID() : undefined)
  }

  async getLastTimeEntries(workspaceId, userId, projectId, count=10, bypassCache=false) {
    return store.compute(`lastEntry:${workspaceId}:${userId}:${projectId || '*'}`, async () => {
      const projectQuery = projectId ? `&project=${projectId}` : '';
      const response = await this.client.get(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/user/${userId}/time-entries?page-size=${count}${projectQuery}`);
      return response.data;
    }, 5, bypassCache ? randomUUID() : undefined)
  }

  async stopCurrentTimeEntry(workspaceId, userId) {
    const entry = await this.getActiveTimeEntry(workspaceId, userId, true);

    if (entry) {
      await this.client.patch(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/user/${userId}/time-entries`, {
        end: new Date().toISOString()
      })
    }
    return this.getActiveTimeEntry(workspaceId, userId, true);
  }

  async startTimeEntry(workspaceId, userId, projectId) {
    const entry = await this.stopCurrentTimeEntry(workspaceId, userId);

    const description = (await this.getLastTimeEntries(workspaceId, userId, projectId))
      .find(({description}) => !!description)
      ?.description || '';

    await this.client.post(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/time-entries`, {
      projectId,
      start: entry ? entry.interval.end : new Date().toISOString(),
      description
    })
    return await this.getActiveTimeEntry(workspaceId, userId, true);
  }

  async updateActiveTimeEntry(workspaceId, userId, { description, start }) {
    const entry = await this.getActiveTimeEntry(workspaceId, userId, true);
    if (entry) {
      try {
        await this.client.put(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/time-entries/${entry.id}`, {
          ..._.pick(entry, 'id', 'projectId', 'taskId', 'tagIds', 'billable'),
          ...(description ? { description } : {}),
          ...(start ? { start: start.toISOString() } : { start: entry.timeInterval.start }),
        })
      } catch (e) {
        console.log(e)
      }
    }
    console.log('Update Successful, returning time entry')
    return await this.getActiveTimeEntry(workspaceId, userId, true);
  }

  async updateTimeEntry(workspaceId, entry, { end }) {
    try {
      await this.client.put(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/time-entries/${entry.id}`, {
        ..._.pick(entry, 'id', 'projectId', 'taskId', 'tagIds', 'billable', 'description'),
        ...({start: entry.timeInterval.start}),
        ...(end ? { end: end.toISOString() } : { end: entry.timeInterval.end }),
      })
    } catch (e) {
      dialog.showMessageBoxSync({
        type: 'error',
        message: "Error updating time entry end time. May require manual intervention.",
        detail: _.get(e, 'response.data.message') || `${e}`,
        title: 'Error updating time entry'
      })
    }
    console.log('Update Successful')
  }

  async whoami() {
    return store.compute(`currentUser`, async () => {
      const response = await this.client.get(`https://api.clockify.me/api/v1/user`);
      return response.data;
    }, 5)
  }
}

module.exports = {
  Clockify
}