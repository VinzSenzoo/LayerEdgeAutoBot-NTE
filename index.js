import cfonts from 'cfonts';
import blessed from 'blessed';
import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import chalk from 'chalk';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class LayerEdgeNode {
  constructor(token, proxy = null, id) {
    this.token = token;
    this.proxy = proxy;
    this.id = id;
    this.userInfo = {};
    this.totalPoints = 0;
    this.status = 'Idle';
    this.ws = null;
    this.heartbeatInterval = null;
    this.uiScreen = null;
    this.accountPane = null;
    this.logPane = null;
    this.isDisplayed = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 30;
    this.logs = [];
    this.ipAddress = 'N/A';
  }

  async start() {
    await this.fetchIpAddress();
    this.connectWebSocket();
  }

  async fetchIpAddress() {
    try {
      if (this.proxy) {
        const agent = this.proxy.type === 'socks5' ? new SocksProxyAgent(this.proxy.url) : new HttpsProxyAgent(this.proxy.url);
        const response = await axios.get('https://api.ipify.org?format=json', {
          httpsAgent: agent,
          httpAgent: agent,
        });
        this.ipAddress = response.data.ip;
        this.addLog(chalk.yellow(`Using proxy IP: ${this.ipAddress}`));
      } else {
        const response = await axios.get('https://api.ipify.org?format=json');
        this.ipAddress = response.data.ip;
        this.addLog(chalk.yellow(`Using local IP: ${this.ipAddress}`));
      }
    } catch (error) {
      this.ipAddress = 'Unknown';
      this.addLog(chalk.red(`Failed to fetch IP: ${error.message}`));
    }
  }


  connectWebSocket() {
    const wsUrl = `wss://websocket.layeredge.io/ws/node?token=${encodeURIComponent(this.token)}`;
    let wsConfig = { rejectUnauthorized: false };
    if (this.proxy) {
      wsConfig.agent = this.proxy.type === 'socks5' ? new SocksProxyAgent(this.proxy.url) : new HttpsProxyAgent(this.proxy.url);
      this.addLog(chalk.yellow(`Using proxy: ${this.proxy.url} (${this.proxy.type})`));
    } else {
      this.addLog(chalk.yellow('No proxy configured'));
    }
    this.ws = new WebSocket(wsUrl, wsConfig);
    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('error', (error) => this.onError(error));
    this.ws.on('close', (code, reason) => this.onClose(code, reason));
  }

  onOpen() {
    this.status = 'Connected';
    this.reconnectAttempts = 0;
    this.addLog(chalk.green('WebSocket connected'));
    this.ws.send(JSON.stringify({ type: 'NodeStart' }));
    this.addLog(chalk.cyan('Sent NodeStart'));
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'Heartbeat' }));
        this.addLog(chalk.green('Sent Heartbeat'));
      }
    }, 15000);
  }

  onMessage(data) {
    try {
      const message = JSON.parse(data);
      if (message.type === 'connected') {
        this.userInfo = message.data;
        this.addLog(chalk.green(`{green-fg}Connected to node{/green-fg} {cyan-fg}User ID: ${this.userInfo.user_id}{/cyan-fg}`));
        this.addLog(chalk.green(`{green-fg}Wallet Address: ${this.userInfo.wallet_address || 'N/A'}{/green-fg}`));
        this.addLog(chalk.green(`{green-fg}User Level: ${this.userInfo.user_level || 'N/A'}{/green-fg}`));
        this.refreshDisplay();
      } else if (message.type === 'PointsUpdate') {
        this.totalPoints = message.data.total_points;
        this.addLog(chalk.blue(`{blue-fg}Points Updated: ${this.totalPoints} points{/blue-fg}`));
        this.refreshDisplay();
      } else if (message.type === 'heartbeat_ack') {
        this.addLog(chalk.gray('Received heartbeat_ack'));
      } else {
        this.addLog(chalk.yellow(`Received unknown message type: ${message.type}`));
      }
    } catch (error) {
      this.addLog(chalk.red(`Error parsing message: ${error.message}`));
    }
  }

  onError(error) {
    if (error.message.includes('401')) {
      this.addLog(chalk.red(`Invalid token: Unauthorized (401)`));
      this.status = 'Error';
      this.cleanup();
    } else {
      this.addLog(chalk.red(`WebSocket error: ${error.message}`));
      this.status = 'Error';
    }
    this.refreshDisplay();
  }

  onClose(code, reason) {
    this.addLog(chalk.red(`WebSocket closed (code: ${code}, reason: ${reason || 'unknown'})`));
    this.status = 'Disconnected';
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (code === 1008 || reason.includes('Unauthorized')) {
      this.addLog(chalk.red('Token invalid. Stopping reconnection.'));
      this.status = 'Error';
      this.refreshDisplay();
    } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.addLog(chalk.yellow(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`));
      setTimeout(() => this.connectWebSocket(), 5000);
    } else {
      this.addLog(chalk.red('Max reconnect attempts reached. Stopping reconnection.'));
      this.status = 'Disconnected';
      this.refreshDisplay();
    }
  }

  addLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] [Node ${this.id}] ${message.replace(/\{[^}]+\}/g, '')}`;
    this.logs.push(logMessage);
    if (this.logs.length > 100) this.logs.shift();
    if (this.logPane && this.isDisplayed) {
      this.logPane.setContent(this.logs.join('\n'));
      this.logPane.setScrollPerc(100);
      this.uiScreen.render();
    }
  }

  refreshDisplay() {
    if (!this.isDisplayed || !this.accountPane || !this.logPane) return;
    const statusColor = this.status === 'Connected' ? 'green' : 'red';
    const info = `
 User ID       : {magenta-fg}${this.userInfo.user_id || 'N/A'}{/magenta-fg}
 Wallet Address: {magenta-fg}${this.userInfo.wallet_address || 'N/A'}{/magenta-fg}
 User Level    : {yellow-fg}${this.userInfo.user_level || 'N/A'}{/yellow-fg}
 Total Points  : {green-fg}${this.totalPoints}{/green-fg}
 Status        : {${statusColor}-fg}${this.status}{/}
 IP Address    : {cyan-fg}${this.ipAddress}{/cyan-fg}
 Proxy         : {cyan-fg}${this.proxy ? `${this.proxy.url} (${this.proxy.type})` : 'None'}{/cyan-fg}
    `;
    this.accountPane.setContent(info);
    this.logPane.setContent(this.logs.join('\n'));
    this.logPane.setScrollPerc(100);
    this.uiScreen.render();
  }

  cleanup() {
    if (this.ws) {
      this.addLog(chalk.yellow('Closing WebSocket connection'));
      this.ws.close();
      this.ws = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  static async loadTokens() {
    try {
      const filePath = path.join(__dirname, 'key.txt');
      const data = await fs.readFile(filePath, 'utf8');
      const tokens = data.split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .map((token, index) => ({ id: index + 1, token }));
      if (!tokens.length) {
        console.error('[ERROR] key.txt is empty');
        return [];
      }
      return tokens;
    } catch (error) {
      console.error(`[ERROR] Failed to load key.txt: ${error.message}`);
      return [];
    }
  }

  static async loadProxies() {
    const proxies = [];
    try {
      const filePath = path.join(__dirname, 'proxy.txt');
      const data = await fs.readFile(filePath, 'utf8');
      const lines = data.split('\n')
        .map(line => line.trim())
        .filter(line => line !== '');
      for (const line of lines) {
        const proxyRegex = /^(socks5|http|https):\/\/(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/i;
        const match = line.match(proxyRegex);
        if (!match) {
          proxies.push({ error: `Invalid proxy format: ${line}. Expected 'socks5://[user:pass@]host:port' or 'http(s)://[user:pass@]host:port', skipping.` });
          continue;
        }
        const [, scheme, username, password, host, port] = match;
        const type = scheme.toLowerCase() === 'socks5' ? 'socks5' : 'http';
        const auth = username && password ? `${username}:${password}@` : '';
        const url = `${scheme}://${auth}${host}:${port}`;
        proxies.push({ type, url });
      }
      if (!proxies.filter(p => !p.error).length) {
        proxies.push({ error: 'No valid proxies found in proxy.txt. Running without proxy.' });
      }
      return proxies;
    } catch (error) {
      proxies.push({ error: `Failed to read proxy.txt: ${error.message}. Running without proxy.` });
      return proxies;
    }
  }
}

async function main() {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'NT EXHAUST Node Runner',
  });

  const headerPane = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 7,
    tags: true,
    align: 'left',
  });
  screen.append(headerPane);

  function renderBanner() {
    const threshold = 80;
    const margin = Math.max(screen.width - 80, 0);
    let art = "";
    if (screen.width >= threshold) {
      art = cfonts.render('NT EXHAUST', {
        font: 'block',
        align: 'center',
        colors: ['cyan', 'magenta'],
        background: 'transparent',
        letterSpacing: 1,
        lineHeight: 1,
        space: true,
        maxLength: screen.width - margin,
      }).string;
    } else {
      art = cfonts.render('NT EXHAUST', {
        font: 'tiny',
        align: 'center',
        colors: ['cyan', 'magenta'],
        background: 'transparent',
        letterSpacing: 1,
        lineHeight: 1,
        space: true,
        maxLength: screen.width - margin,
      }).string;
    }
    headerPane.setContent(art + '\n');
    headerPane.height = Math.min(8, art.split('\n').length + 2);
  }
  renderBanner();

  const channelPane2 = blessed.box({
    top: '25%',
    left: 2,
    width: '100%',
    height: 2,
    tags: false,
    align: 'center',
  });
  channelPane2.setContent('✪ BOT LAYER EDGE AUTO RUN NODE ✪');
  screen.append(channelPane2);

  const infoPane = blessed.box({
    bottom: 0,
    left: 'center',
    width: '100%',
    height: 2,
    tags: true,
    align: 'center',
  });
  screen.append(infoPane);

  const dashTop = headerPane.height + channelPane2.height;
  const dashHeight = `100%-${dashTop + 3}`;
  const accountPane = blessed.box({
    top: dashTop,
    left: 0,
    width: '50%',
    height: '60%',
    border: { type: 'line' },
    label: ' User Info ',
    tags: true,
    style: { border: { fg: 'yellow' }, fg: 'white', bg: 'default' },
  });
  screen.append(accountPane);

  const logPane = blessed.log({
    top: dashTop,
    left: '50%',
    width: '50%',
    height: '60%',
    border: { type: 'line' },
    label: ' System Logs ',
    tags: true,
    style: { border: { fg: 'yellow' }, fg: 'white', bg: 'default' },
    scrollable: true,
    scrollbar: { bg: 'blue', fg: 'white' },
    alwaysScroll: true,
    mouse: true,
    keys: true,
  });
  screen.append(logPane);

  logPane.on('keypress', (ch, key) => {
    if (key.name === 'up') {
      logPane.scroll(-1);
      screen.render();
    } else if (key.name === 'down') {
      logPane.scroll(1);
      screen.render();
    } else if (key.name === 'pageup') {
      logPane.scroll(-10);
      screen.render();
    } else if (key.name === 'pagedown') {
      logPane.scroll(10);
      screen.render();
    }
  });

  logPane.on('mouse', (data) => {
    if (data.action === 'wheelup') {
      logPane.scroll(-2);
      screen.render();
    } else if (data.action === 'wheeldown') {
      logPane.scroll(2);
      screen.render();
    }
  });

  let tokens = await LayerEdgeNode.loadTokens();
  let proxies = await LayerEdgeNode.loadProxies();
  let activeIndex = 0;
  let nodes = [];

  function updateNodes() {
    nodes.forEach(node => node.cleanup());
    nodes = tokens.map((token, idx) => {
      const proxyEntry = proxies[idx % proxies.length] || null;
      const proxy = proxyEntry && !proxyEntry.error ? { ...proxyEntry } : null;
      const node = new LayerEdgeNode(token.token, proxy, token.id);
      node.uiScreen = screen;
      node.accountPane = accountPane;
      node.logPane = logPane;
      if (proxyEntry && proxyEntry.error) {
        node.addLog(chalk.yellow(proxyEntry.error));
      }
      return node;
    });

    if (nodes.length > 0) {
      nodes[activeIndex].isDisplayed = true;
      nodes[activeIndex].addLog(chalk.green('Node initialized successfully'));
      nodes[activeIndex].refreshDisplay();
      nodes.forEach(node => node.start());
    } else {
      logPane.setContent('No valid tokens found in key.txt.\nPress \'q\' or Ctrl+C to exit.');
      accountPane.setContent('');
      screen.render();
    }
  }

  updateNodes();

  if (!nodes.length) {
    screen.key(['escape', 'q', 'C-c'], () => {
      screen.destroy();
      process.exit(0);
    });
    screen.render();
    return;
  }

  infoPane.setContent(`Current Account: ${nodes.length > 0 ? activeIndex + 1 : 0}/${nodes.length} | Use Left/Right arrow keys to switch accounts.`);

  screen.key(['escape', 'q', 'C-c'], () => {
    nodes.forEach(node => {
      node.cleanup();
      node.addLog(chalk.yellow('Node stopped'));
    });
    screen.destroy();
    process.exit(0);
  });

  screen.key(['right'], () => {
    if (nodes.length === 0) return;
    nodes[activeIndex].isDisplayed = false;
    activeIndex = (activeIndex + 1) % nodes.length;
    nodes[activeIndex].isDisplayed = true;
    nodes[activeIndex].refreshDisplay();
    infoPane.setContent(`Current Account: ${activeIndex + 1}/${nodes.length} | Use Left/Right arrow keys to switch accounts.`);
    screen.render();
  });

  screen.key(['left'], () => {
    if (nodes.length === 0) return;
    nodes[activeIndex].isDisplayed = false;
    activeIndex = (activeIndex - 1 + nodes.length) % nodes.length;
    nodes[activeIndex].isDisplayed = true;
    nodes[activeIndex].refreshDisplay();
    infoPane.setContent(`Current Account: ${activeIndex + 1}/${nodes.length} | Use Left/Right arrow keys to switch accounts.`);
    screen.render();
  });

  screen.key(['tab'], () => {
    logPane.focus();
    screen.render();
  });

  screen.on('resize', () => {
    renderBanner();
    headerPane.width = '100%';
    channelPane2.top = headerPane.height;
    accountPane.top = dashTop;
    logPane.top = dashTop;
    screen.render();
  });

  screen.render();
}

main().catch(error => {
  console.error(`[ERROR] Failed to start: ${error.message}`);
  const screen = blessed.screen({ smartCSR: true, title: 'NT EXHAUST Node Runner' });
  const logPane = blessed.box({
    top: 'center',
    left: 'center',
    width: '80%',
    height: '100%',
    border: { type: 'line' },
    label: ' System Logs ',
    content: `Failed to start: ${error.message}\nPlease fix the issue and restart.\nPress 'q' or Ctrl+C to exit`,
    style: { border: { fg: 'red' }, fg: 'blue', bg: 'default' },
  });
  screen.append(logPane);
  screen.key(['escape', 'q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });
  screen.render();
});