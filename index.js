const { CybroController } = require('./controller');
const { CybroComm } = require('./comm');
const dgram = require('dgram');
const EventEmitter = require('events');

class Cybro extends EventEmitter {
	constructor(port) {
		super();
		
		this.nadAutodetect = 4027370282;
		this.port = port;
		this.controllers = [];
		
	}
	
	async listen() {
		this.socket = dgram.createSocket('udp4');

		this.socket.on('close', () => {
			this.emit('close');
		});

		this.socket.on('connect', () => {
			this.emit('connect');
		});

		this.socket.on('error', (err) => {
			this.emit('error', err);
			this.socket.close();
		});

		this.socket.on('listening', () => {
			this.emit('listening');
		});

		this.socket.on('message', (data, rinfo) => {
			// Broadcast message further on
			this.emit('message', data, rinfo);
			
			let controller = this.controllers.find((controller) => {
				return controller.address == rinfo.address;
			});

			// Parse frame
			let frame = CybroComm.frameParse(data);

			// Response back to the controller
			if (controller) {
				// Emit frame to the controller
				controller.emit('frame', frame);
			}

			// Bradcast autodetected controller
			if (frame.nadTo == this.nadAutodetect) {
				this.emit('controller', frame, rinfo.address);
			}
		});

		return new Promise(async (resolve, reject) => {
			this.socket.bind(this.port, (err) => {
				if (err) {
					reject(err);
				}
				resolve();
			});
		});

	}
	
	async close() {
		return new Promise(async (resolve, reject) => {
			this.socket.close(() => {
				resolve();
			});
		});
	}

	async addController(address, nad, password) {
		// Check if controller object has already been created
		let controller = this.controllers.find((controller) => {
			return controller.address == address;
		});
		
		// Return existing controller if it exist
		if (controller) {
			return controller;
		}
		
		// Create new controller object when 
		controller = new CybroController(this, address, this.port, nad, password)
		this.controllers.push(controller);
		
		// Run configuration on the controller
		await controller.readConfiguration();
		
		// Return new controller
		return controller;
	}

	async autodetect(broadcastAddress) {
		return new Promise(async (resolve, reject) => {
			let controllers = [];

			// Prepare status package with 0 nad as destination
			let comm = new CybroComm(null, null, null, this.nadAutodetect, 0, 0);
			let frame = comm.frame(0, 0, Buffer.from([0x11]));

			// Broadcast autodetect package
			this.socket.setBroadcast(true);
			this.socket.send(frame, this.port, broadcastAddress || '255.255.255.255', (err) => {
				this.socket.setBroadcast(false);
				// Reject on error
				if (err) {
					reject(err);
				}
			});

			// Set callback for new controller event
			let callback = (frame, address) => {
				controllers.push({
					address: address,
					nad: frame.nadFrom
				});
			}

			// Register callback with the event
			this.on(`controller`, callback);

			// After 50ms response with the list of controllers and remove the event listener
			setTimeout(() => {
				this.removeListener(`controller`, callback);
				resolve(controllers);
			}, 50);
		});
	}
}

module.exports = {
	Cybro
}