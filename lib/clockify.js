const { randomUUID } = require('crypto');
const axios = require('axios');

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
    return value && [undefined, value[0]].includes(version) ?
      value[1] : undefined;
  }

  compute(key, fn, ttl, version) {
    const value = this.internal[key];
    if (value && [undefined, value[0]].includes(version)) {
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
    );
    return newValueResolvable;
  }

  set(key, value, ttl) {
    const version = randomUUID().toString();
    this.internal[key] = [version, value]
    setTimeout(() => {
      if (this.version(key) === version) {
        delete this.internal[key];
      }
    }, (ttl || this.ttl) * 1000)
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
    await this.client.post(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/time-entries`, {
      projectId,
      start: entry ? entry.interval.end : new Date().toISOString()
    })
    return await this.getActiveTimeEntry(workspaceId, userId, true);
  }

  async updateActiveTimeEntry(workspaceId, userId, { description, start }) {
    const entry = await this.getActiveTimeEntry(workspaceId, userId, true);
    if (entry) {
      await this.client.put(`https://api.clockify.me/api/v1/workspaces/${workspaceId}/time-entries/${entry.id}`, {
        description
      })
    }
    return await this.getActiveTimeEntry(workspaceId, userId, true);
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