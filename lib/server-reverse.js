const WebSocketServer = require('websocket').server;
const https = require('https');
const { URLSearchParams } = require('url');
const net = require('net');
const _ = require('lodash');
const dayjs = require('dayjs');
const selfsigned = require('selfsigned');
const isPortReachable = require('is-port-reachable');
const randomstring = require('randomstring');
const simpleEncryptor = require('simple-encryptor');
const BindSocketsReverse = require('./bind-sockets');
const { EventEmitter } = require('events');
const logger = require('debug')('WstServerReverse');

// set max event emitter
EventEmitter.prototype._maxListeners = 1000;

class WstServerReverse {
  constructor (secret) {
    const httpHandler = (request, response) => {
      response.writeHead(404);

      return response.end();
    };
    const pem = selfsigned.generate();
    const httpServer = https.createServer(
      {
        key: pem.private,
        cert: pem.cert,
      },
      httpHandler,
    );

    const wsServerForControl = new WebSocketServer({
      httpServer,
      useNativeKeepalive: true,
      keepalive: true,
      autoAcceptConnections: false,
    });

    this.latestConnectedTime = dayjs().unix();
    this.secret = secret;
    this.httpServer = httpServer;
    this.wsServerForControl = wsServerForControl;
    this.newWSTCPEmitter = new EventEmitter();
  }

  start ({ port, minRandomPort = 1, maxRandomPort = (16 ** 4) - 1 }) {
    this.httpServer.listen(port, () => {
      logger(`Server is listening on port: ${port}`);
    });

    this.wsServerForControl.on('request', ((_this) => {
      return async (request) => {
        // One TCP Server for each client WS Request
        request.tcpServer = net.createServer();

        // parse to http uri
        const uri = new URLSearchParams(_.get(request, 'httpRequest.url', '').replace(/^\//, ''));
        const dst = uri.get('dst');
        if (dst) {
          const fetchPort = async () => {
            const getPort = () => {
              const portNumber = _.random(minRandomPort, maxRandomPort);
              return isPortReachable(
                portNumber,
                {
                  host: 'localhost',
                },
              ).then(
                reachable => (reachable ? getPort() : portNumber),
              );
            };

            return dst === 'random' ? getPort() : dst;
          };

          const portTcp = await fetchPort();

          // start tcp server
          request.tcpServer.listen(portTcp);
          logger(`Created TCP server on port: ${portTcp}`);

          // add accept header
          request.wsConnectionForControl = request.accept('tunnel-protocol', request.origin);

          // start message
          logger('WS Connection for Control Created');
          request.wsConnectionForControl.on('error', logger);
          request.wsConnectionForControl.on('close', (reasonCode, description) => {
            logger(`WebSocket Control Peer ${_.get(request, 'wsConnectionForControl.remoteAddress')} disconnected for: ${description}`);
            logger(`Close TCP server on port ${portTcp}`);

            request.tcpServer.close();
          });
        } else {
          logger('Request for Data WS Socket');

          // emit request
          this.newWSTCPEmitter.emit('created', request);
        }

        // add error callback
        request.tcpServer.on('error', logger);

        // Manage TCP Connection
        request.tcpServer.on('connection', ((_this) => {
          return (tcp) => {
            // Putting in pause the tcp connection waiting the new socket WS Socket for data
            tcp.pause();

            // create connection
            const idConnection = randomstring.generate(20);
            const msgForNewConnection = `NC:${idConnection}`;

            // send utf message for new connection
            request.wsConnectionForControl.sendUTF(msgForNewConnection);

            const eventManager = ((_this) => {
              return (request) => {
                try {
                  const encryptor = simpleEncryptor(_this.secret);
                  const requestUrl = _.get(request, 'httpRequest.url', '');
                  const uri = new URLSearchParams(requestUrl.replace(/^\//, ''));
                  const id = uri.get('id');
                  const token = uri.get('token');
                  const decryptedToken = encryptor.decrypt(token);
                  const time = _.toInteger(decryptedToken);

                  // check connection state
                  if (idConnection === id && (dayjs().unix() - time) < 30) {
                    const ws = request.accept('tunnel-protocol', request.origin);
                    const bind = new BindSocketsReverse(ws, tcp);

                    // start bind service
                    bind.start();

                    // Resuming of the tcp connection after WS Socket is just created
                    tcp.resume();

                    // mark this object as connected
                    _this.isConnected = true;

                    // save latest connected time
                    _this.latestConnectedTime = dayjs().unix();

                    _this.newWSTCPEmitter.removeListener('created', eventManager);
                  }
                } catch (error) {
                  logger('Error:');
                  logger(error);
                  request.tcpServer.close();

                  _this.newWSTCPEmitter.removeListener('created', eventManager);
                }
              };
            })(this);

            this.newWSTCPEmitter.on('created', eventManager);
          };
        })(_this));
      };
    })(this));
  }
}

module.exports = WstServerReverse;
