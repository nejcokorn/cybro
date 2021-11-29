const EventEmitter = require('events');
const dgram = require('dgram');

class CybroComm extends EventEmitter {

	// This is how the frame package looks like
	// aa55 0600 16510000 714c57b8 01 00 0102 0000 d04b
	// aa55 - signature
	// 0500 - length
	// 16510000 - from nad
	// 00000000 - to nad
	// 01 - direction
	// 00 - type(Socket)
	// 0102 - data
	// 0000 - password
	// d04b -  checksum

	constructor(controller, address, port, nadTo, password) {
		super();

		this.lastPromiseQueue = new Promise(async(resolve, reject) => { resolve(); });

		this.socket = null
		this.controller = controller;
		this.address = address;
		this.port = port;
		this.nadTo = nadTo;
		this.password = password;

		this.segmentSize = 256;
		this.cmd = {
			ping: 0x10,
			status: 0x11,
			readCode: 0x21,
			writeCode: 0x22,
			writeData: 0x32,
			read: 0x33,
			write: 0x34,
			plcStart: 0x40,
			plcStop: 0x41,
			plcPause: 0x45
		}
	}

	async connect() {
		return new Promise(async (resolve, reject) => {
			// Create socket
			this.socket = dgram.createSocket({
				type: 'udp4',
				reuseAddr: true
			});

			// Log close event
			this.socket.on('close', () => {
				console.log("Socket closed");
			});

			// Log connect event
			this.socket.on('connect', () => {
				console.log("Socket connected");
			});

			// Log error events
			this.socket.on('error', (err) => {
				console.log("Socket error");
				console.error(err);
			});

			// Log listening event
			this.socket.on('listening', () => {
				console.log("Socket listening");
				resolve();
			});

			// Monitor messages
			this.socket.on('message', (data, rinfo) => {

				// Parse frame
				let frame = CybroComm.frameParse(data);

				// Skip if package does not originate from registred controller
				if (rinfo.address != this.address) {
					return;
				}

				// Check if package is a socket data from controller
				if (frame.socket != 0) {
					return this.emit(`socket`, frame);
				}

				// Direction 1 means it is a response to one of the waiting requests
				if (frame.direction == 1) {
					this.emit(`response`, frame);
					this.emit(`response_${frame.nadTo}`, frame);
				}
			});
			
			// Start listening to UDP port
			this.socket.bind(this.port);
		});
	}

	static async autodetect(port) {
		return new Promise(async (resolve, reject) => {
			// Array of controllers
			let controllers = [];
			
			// Create new socket
			let socket = dgram.createSocket({
				type: 'udp4',
				reuseAddr: true
			});

			// Create autodetect broadcast frame
			let nadFrom = CybroComm.randomNadFrom();
			let frame = CybroComm.frame(0, 0, nadFrom, 0, Buffer.from([0x11]), 0);

			// Wait for socket to start listening
			socket.on('listening', () => {
				// Set broadcast
				socket.setBroadcast(true);

				// Send autodetect package
				socket.send(frame, port, '255.255.255.255', (err) => {
					if (err) {
						reject(err);
					}
				});
			});

			// Wait for responses
			socket.on('message', (buffer, rinfo) => {
				// CybroComm.frameVerify(buffer);
				// Parse UDP package
				let frame = CybroComm.frameParse(buffer);

				// Any response is a controller
				if (frame.direction == 1 && frame.nadTo == nadFrom) {
					controllers.push({ address: rinfo.address, nad: frame.nadFrom });
				}
			});

			// Start listening to UDP port
			socket.bind(port);

			// After 50 miliseconds return set of available controllers
			setTimeout(() => {
				// Stop listening
				socket.close();

				// Return controllers
				resolve(controllers);
			}, 50);
		});
	}

	async lock() {
		// Get last item in queue
		let queuePromise = this.lastPromiseQueue;

		// Create lock object
		let lock = {
			release: () => {}
		}

		// New promise for this lock
		this.lastPromiseQueue = new Promise(async(resolve, reject) => {
			lock.release = resolve;
		});

		// Wait for existing promises in queue
		await queuePromise;

		// Return lock object
		return lock;
	}

	async ping() {
		// Wait for active connections
		let lock = await this.lock();

		try {
			// Measure time before sending ping package
			let startTime = process.hrtime();
			// Any response back is success
			let pong = await this.send({
				direction: 0,
				socket: 0,
				nadTo: this.nadTo,
				dataBuf: Buffer.from([this.cmd.ping]),
				password: this.password
			});

			// Evaluate time passed after receiving response from the ping package
			var elapsedSeconds = process.hrtime(startTime)[0];
			var elapsedTheRest = process.hrtime(startTime)[1] / 1000000000;

			// Returned time is in miliseconds
			return Number(elapsedSeconds) + Number(elapsedTheRest.toFixed(6));
		} catch (e) {
			return false;
		} finally {
			// Release the lock
			lock.release();
		}
	}

	async status() {
		// Wait for active connections
		let lock = await this.lock();

		try {
			// Send status package
			let status = await this.send({
				direction: 0,
				socket: 0,
				nadTo: this.nadTo,
				dataBuf: Buffer.from([this.cmd.status]),
				password: this.password
			});

			if (status.data[0] == 0){
				return -1;
			} else {
				return status.data[1];
			}
		} catch (e) {
			return false;
		} finally {
			// Release the lock
			lock.release();
		}
	}

	async plcStart() {
		// Wait for active connections
		let lock = await this.lock();

		try {
			// Send PLC Start package
			await this.send({
				direction: 0,
				socket: 0,
				nadTo: this.nadTo,
				dataBuf: Buffer.from([this.cmd.plcStart]),
				password: this.password
			});
			return true;
		} catch (e) {
			return false;
		} finally {
			// Release the lock
			lock.release();
		}
	}

	async plcStop() {
		// Wait for active connections
		let lock = await this.lock();

		try {
			// Send PLC Stop package
			await this.send({
				direction: 0,
				socket: 0,
				nadTo: this.nadTo,
				dataBuf: Buffer.from([this.cmd.plcStop]),
				password: this.password
			});
			return true;
		} catch (e) {
			return false;
		} finally {
			// Release the lock
			lock.release();
		}
	}

	async plcPause() {
		// Wait for active connections
		let lock = await this.lock();

		try {
			// Send PLC Pause package
			await this.send({
				direction: 0,
				socket: 0,
				nadTo: this.nadTo,
				dataBuf: Buffer.from([this.cmd.plcPause]),
				password: this.password
			});
			return true;
		} catch (e) {
			return false;
		} finally {
			// Release the lock
			lock.release();
		}
	}

	async readCode(address, size) {
		// Wait for active connections
		let lock = await this.lock();

		try {
			let codeBuffer = Buffer.alloc(size);

			// Extract code from segments
			let segment = Math.floor(address / this.segmentSize);
			let blocks = Math.floor((address + size) / this.segmentSize) - segment + 1;
			let segmentBuffer = await this.readSegment(segment, blocks);

			// Copy wanted code from segment data
			segmentBuffer.copy(codeBuffer, 0, address % this.segmentSize, address % this.segmentSize + size);

			return codeBuffer;
		} catch (err) {
			return err
		} finally {
			// Release the lock
			lock.release();
		}
	}

	async readSegment(segment, blocks) {
		let data = Buffer.alloc(0);

		// Read blocks
		for(let i = 0; i < blocks; i++) {
			let frameDataBuf = Buffer.alloc(5);
			frameDataBuf.writeUInt8(this.cmd.readCode);
			frameDataBuf.writeUInt16LE(segment + i, 1);
			frameDataBuf.writeUInt16LE(this.segmentSize, 3);

			let chunkFrame = await this.send({
				direction: 0,
				socket: 0,
				nadTo: this.nadTo,
				dataBuf: frameDataBuf,
				password: this.password
			});

			data = Buffer.concat([data, chunkFrame.data], data.length + chunkFrame.data.length);
		}

		return data;
	}

	// Read | numB | numI | numL | addrB ...
	// 33   | 0000 | 0000 | 0000 | 0624 ...
	// variables = [
	// 	{
	// 		name: "bio00_ix00",
	// 		value: 1
	// 	}
	// ]
	async read(variables) {
		let controller = this.controller;

		// Filter out unknown variables
		variables = variables.filter((variable) => {
			return controller.registry[variable.name];
		});

		// Sort variables by size
		variables = variables.sort((a, b) => {
			return parseInt(controller.registry[a.name].size) - parseInt(controller.registry[b.name].size);
		});

		// Count variables
		let countByte = 0;
		let countShort = 0;
		let countLong = 0;
		for (let variable of variables) {
			switch (parseInt(controller.registry[variable.name].size)) {
				case 1:
					countByte++;
					break;
				case 2:
					countShort++;
					break;
				case 4:
					countLong++;
					break;
			}
		}

		// Allocate buffer
		let dataBuf = Buffer.alloc(7 + variables.length * 2);

		// Writte command to data buffer
		let offset = 0;
		dataBuf.writeUInt8(this.cmd.read);
		offset += 1;

		// Write lengths
		dataBuf.writeUInt16LE(countByte, offset);
		offset += 2;
		dataBuf.writeUInt16LE(countShort, offset);
		offset += 2;
		dataBuf.writeUInt16LE(countLong, offset);
		offset += 2;

		// Write addresses
		for (let variable of variables) {
			dataBuf.writeUInt16LE(parseInt(controller.registry[variable.name].address, 16), offset);
			offset += 2;
		}

		// Wait for active connections
		let lock = await this.lock();

		try {
			// Send frame to get data
			let responseFrame = await this.send({
				direction: 0,
				socket: 0,
				nadTo: this.nadTo,
				dataBuf: dataBuf,
				password: this.password
			});

			// Parse values
			offset = 0;
			for (let variable of variables) {
				switch (controller.registry[variable.name].type) {
					case 'bit':
					variable.value = responseFrame.data.readUInt8(offset);
					break;
					case 'int':
					variable.value = responseFrame.data.readInt16LE(offset);
					break;
					case 'long':
					variable.value = responseFrame.data.readInt32LE(offset);
					break;
					case 'real':
					variable.value = responseFrame.data.readFloatLE(offset);
					break;
				}
				offset += parseInt(controller.registry[variable.name].size);
			}
		} catch (e) {
			// TODO
		} finally {
			// Release the lock
			lock.release();
		}
		return variables;
	}

	// Read | numB | numI | numL | addrB... | value ....
	// 33   | 0100 | 0000 | 0000 | 0624...  | 01 ...
	// variables = [
	// 	{
	// 		name: "bio00_ix00",
	// 		value: 1
	// 	}
	// ]
	async write(variables) {
		let controller = this.controller;

		// Filter out unknown variables
		variables = variables.filter((variable) => {
			return controller.registry[variable.name];
		});

		// Sort variables by size
		variables = variables.sort((a, b) => {
			return parseInt(controller.registry[a.name].size) - parseInt(controller.registry[b.name].size);
		});

		// Count variables
		let countByte = 0;
		let countShort = 0;
		let countLong = 0;
		for (let variable of variables) {
			switch (parseInt(controller.registry[variable.name].size)) {
				case 1:
					countByte++;
					break;
				case 2:
					countShort++;
					break;
				case 4:
					countLong++;
					break;
			}
		}

		// Allocate buffer
		let dataBuf = Buffer.alloc(7 + countByte * 3 + countShort * 4 + countLong * 4);

		// Writte command to data buffer
		let offset = 0;
		dataBuf.writeUInt8(this.cmd.write);
		offset += 1;

		// Write lengths
		dataBuf.writeUInt16LE(countByte, offset);
		offset += 2;
		dataBuf.writeUInt16LE(countShort, offset);
		offset += 2;
		dataBuf.writeUInt16LE(countLong, offset);
		offset += 2;

		// Write addresses
		for (let variable of variables) {
			dataBuf.writeUInt16LE(parseInt(controller.registry[variable.name].address, 16), offset);
			offset += 2;
		}

		// Write values
		for (let variable of variables) {
			switch (controller.registry[variable.name].type) {
				case 'bit':
					dataBuf.writeUInt8(variable.value, offset);
					break;
				case 'int':
					dataBuf.writeInt16LE(variable.value, offset);
					break;
				case 'long':
					dataBuf.writeInt32LE(variable.value, offset);
					break;
				case 'real':
					dataBuf.writeFloatLE(variable.value, offset);
					break;
			}
			offset += parseInt(controller.registry[variable.name].size);
		}

		// Wait for active connections
		let lock = await this.lock();

		try {
			// Write data to controller variables
			await this.send({
				direction: 0,
				socket: 0,
				nadTo: this.nadTo,
				dataBuf: dataBuf,
				password: this.password
			});
			return true;
		} catch (e) {
			return false;
		} finally {
			// Release the lock
			lock.release();
		}
	}

	async send(options, retry = 5) {
		// Expand options
		let { direction, socket, nadFrom, nadTo, dataBuf, password } = options;

		// Evaluate nadFrom
		nadFrom = nadFrom !== undefined ? nadFrom : this.nextNadFrom();

		// Evaluate password
		password = password !== undefined ? password : 0;

		// Create udp4 frame package
		let frame = null;
		try {
			frame = CybroComm.frame(direction, socket, nadFrom, nadTo, dataBuf, password);
		} catch (e) {
			return e;
		}

		return new Promise(async (resolve, reject) => {
			this.socket.send(frame, this.port, this.address, (err) => {
				// Reject on error
				if (err) {
					reject(err);
				}
			});

			// Define timeout
			let timeout = null;

			// Callback for response processing
			let callback = (frame) => {
				clearTimeout(timeout);
				resolve(frame);
			}

			// Listen for the response event
			this.once(`response_${nadFrom}`, callback);

			// Set timeout for this request
			timeout = setTimeout(async () => {
				this.removeListener(`response_${nadFrom}`, callback);

				// Retry failed attempt
				if (retry > 1) {
					try {
						resolve(await this.send(options, --retry));
					} catch (e) {
						reject();
					}
				} else {
					reject();
				}
			}, 5);
		});
	}

	nextNadFrom(max) {
		this.nadFromCurrent = this.nadFromCurrent ? this.nadFromCurrent + 1 : 4017370282;
		this.nadFromCurrent = this.nadFromCurrent > 4027370282 ? 4017370282 : this.nadFromCurrent;
		return this.nadFromCurrent;
	}

	static randomNadFrom(max) {
		return 4000000000 + Math.floor(Math.random() * Math.floor(1000000));
	}

	static frame(direction, socket, nadFrom, nadTo, dataBuf, password) {
		// Create buffers
		let signatureBuf = Buffer.from("aa55", 'hex');

		let lengthBuf = (new Buffer.alloc(2))
		lengthBuf.writeUInt16LE(dataBuf.length + 4);

		let nadFromBuf = (new Buffer.alloc(4))
		nadFromBuf.writeUInt32LE(nadFrom);

		let nadToBuf = (new Buffer.alloc(4))
		nadToBuf.writeUInt32LE(nadTo);

		let directionBuf = (new Buffer.alloc(1))
		directionBuf.writeUInt8(direction);

		let socketBuf = (new Buffer.alloc(1))
		socketBuf.writeUInt8(socket);

		let passwordBuf = password ? CybroComm.frameCRC(Buffer.from(password, 'utf8')) : Buffer.from("0000", 'hex');

		// Signature(2), Length(2), nadFrom(4), nadTo(4), direction(1), socket(1), data(x), password(2), crc(2)
		let frame = Buffer.concat([signatureBuf, lengthBuf, nadFromBuf, nadToBuf, directionBuf, socketBuf, dataBuf, passwordBuf], 14 + passwordBuf.length + dataBuf.length);

		// Calculate frame CRC and return buffer with crc
		return Buffer.concat([frame, CybroComm.frameCRC(frame)], frame.length + 2);
	}

	static frameParse(buf) {
		if (!Buffer.isBuffer(buf)) {
			throw new Error('Parameter should be of type Buffer');
		}

		if (!(buf[0] == 0xAA && buf[1] == 0x55)) {
			throw new Error('Frame signature is incorrect');
		}

		if (!CybroComm.frameVerify(buf)) {
			throw new Error('Incorrect frame CRC');
		}

		let frame = null;
		try {
			frame = {
				signature: buf.readUInt16LE(2),
				length: buf.readUInt16LE(2),
				nadFrom: buf.readUInt32LE(4),
				nadTo: buf.readUInt32LE(8),
				direction: buf.readUInt8(12),
				socket: buf.readUInt8(13),
			}
			frame.data = buf.slice(14, 14 + frame.length - 4);
			frame.password = buf.readUInt16LE(14, 14 + buf.readUInt16LE(2));
		} catch (e) {
			return e;
		} finally {
			return frame;
		}
	}

	static frameCRC(buf) {
		let crcBuf = Buffer.alloc(2);
		let crc = 0;

		// CRC table
		let crcTable = [0x049D, 0x0C07, 0x1591, 0x1ACF, 0x1D4B, 0x202D, 0x2507, 0x2B4B, 0x34A5, 0x38C5, 0x3D3F, 0x4445, 0x4D0F, 0x538F, 0x5FB3, 0x6BBF]

		// Loop
		for (let pair of buf.entries()) {
			crc += (pair[1] ^ 0x5A) * crcTable[pair[0] & 0x0F];
		}

		// Take only first 2 bytes and convert it to unsigned little endian
		crcBuf.writeUInt16LE(crc & 0xFFFF);

		return crcBuf;
	}

	static frameVerify(buf) {
		let crcBuf = Buffer.alloc(2);
		let crc = 0;

		// CRC table
		let crcTable = [0x049D, 0x0C07, 0x1591, 0x1ACF, 0x1D4B, 0x202D, 0x2507, 0x2B4B, 0x34A5, 0x38C5, 0x3D3F, 0x4445, 0x4D0F, 0x538F, 0x5FB3, 0x6BBF]

		// Loop
		for (let pair of buf.entries()) {
			if (pair[0] < buf.length - 2) {
				crc += (pair[1] ^ 0x5A) * crcTable[pair[0] & 0x0F];
			}
		}

		// Take only first 2 bytes and convert it to unsigned little endian
		crcBuf.writeUInt16LE(crc & 0xFFFF);

		// Check if crc is the same
		return crcBuf[0] == buf[buf.length - 2] && crcBuf[1] == buf[buf.length - 1]
	}
}

module.exports = {
	CybroComm
}
