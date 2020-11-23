class CybroComm {

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

	constructor(controller, address, port, nadFrom, nadTo, password) {
		
		this.controller = controller;
		this.address = address;
		this.port = port;
		this.nadFrom = nadFrom;
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

	async ping() {
		// Create ping frame
		let framePing = this.frame(0, 0, Buffer.from([this.cmd.ping]));
		// Measure time before sending ping package
		let startTime = process.hrtime();
		// Any response back is success
		let pong = await this.send(framePing);
		// Measure time after receiving response from the ping package
		let endTime = process.hrtime();
		// Returned time is in miliseconds
		return (endTime[0] - startTime[0]) * 1000 + (endTime[1] - startTime[1]) / 10000000;
	}

	async status() {
		let frameStatus = this.frame(0, 0, Buffer.from([this.cmd.status]));
		let status = await this.send(frameStatus);
		
		if (status.data[0] == 0){
			return -1;
		} else {
			return status.data[1];
		}
	}

	async plcStart() {
		try {
			let framePlcStart = this.frame(0, 0, Buffer.from([this.cmd.plcStart]));
			await this.send(framePlcStart);
		} catch (e) {
			return false;
		} finally {
			return true;
		}
	}

	async plcStop() {
		try {
			let framePlcStop = this.frame(0, 0, Buffer.from([this.cmd.plcStop]));
			await this.send(framePlcStop);
		} catch (e) {
			return false;
		} finally {
			return true;
		}
	}

	async plcPause() {
		try {
			let framePlcPause = this.frame(0, 0, Buffer.from([this.cmd.plcPause]));
			await this.send(framePlcPause);
		} catch (e) {
			return false;
		} finally {
			return true;
		}
	}

	async readCode(address, size) {
		let codeBuffer = Buffer.alloc(size);

		// Extract code from segments
		let segment = Math.floor(address / this.segmentSize);
		let blocks = Math.floor((address + size) / this.segmentSize) - segment + 1;
		let segmentBuffer = await this.readSegment(segment, blocks);
		
		// Copy wanted code from segment data
		segmentBuffer.copy(codeBuffer, 0, address % this.segmentSize, address % this.segmentSize + size);
		
		return codeBuffer;
	}
	
	async readSegment(segment, blocks) {
		let data = Buffer.alloc(0);
		
		// Read blocks
		for(let i = 0; i < blocks; i++) {
			let frameDataBuf = Buffer.alloc(5);
			frameDataBuf.writeUInt8(this.cmd.readCode);
			frameDataBuf.writeUInt16LE(segment + i, 1);
			frameDataBuf.writeUInt16LE(this.segmentSize, 3);
			let frame = this.frame(0, 0, frameDataBuf);
			
			let chunkFrame = await this.send(frame);
			
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

		// Parse returned frame
		let frame = this.frame(0, 0, dataBuf);
		let responseFrame = await this.send(frame);

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

		let frame = this.frame(0, 0, dataBuf);
		await this.send(frame);
		
		return true;
	}
	
	async send(frame) {
		let comm = this;
		return new Promise(async (resolve, reject) => {
			comm.controller.cybro.socket.send(frame, this.port, this.address, (err) => {
				// Reject on error
				if (err) {
					reject(err);
				}
			});

			// wait for the replay from the controller
			comm.controller.once(`nad_${comm.nadFrom}`, (frame) => {
				resolve(frame);
			})
		});
	}

	frame(direction, socket, dataBuf) {
		// Create buffers
		let signatureBuf = Buffer.from("aa55", 'hex');
		
		let lengthBuf = (new Buffer.alloc(2))
		lengthBuf.writeUInt16LE(dataBuf.length + 4);
		
		let nadFromBuf = (new Buffer.alloc(4))
		nadFromBuf.writeUInt32LE(this.nadFrom);
		
		let nadToBuf = (new Buffer.alloc(4))
		nadToBuf.writeUInt32LE(this.nadTo);
		
		let directionBuf = (new Buffer.alloc(1))
		directionBuf.writeUInt8(direction);
		
		let socketBuf = (new Buffer.alloc(1))
		socketBuf.writeUInt8(socket);
		
		let passwordBuf = this.password ? CybroComm.frameCRC(Buffer.from(this.password, 'utf8')) : Buffer.from("0000", 'hex');
		
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

	static randomNad(max) {
		return 4000000000 + Math.floor(Math.random() * Math.floor(1000000));
	}
}

module.exports = {
	CybroComm
}