const { CybroController } = require('./controller');
const { CybroComm } = require('./comm');

controllers = [];

module.exports = {
	getController: async (address, port = 8442, nad, password) => {
		// Check if controller object has already been created
		let controller = controllers.find((controller) => {
			return controller.address == address;
		});
		
		// Return existing controller if it exist
		if (controller) {
			return controller;
		}
		
		// Create new controller object when 
		controller = new CybroController(address, port, nad, password);

		// Connect with controller
		await controller.connect();

		// Add to the list of controllers
		controllers.push(controller);

		// Run configuration on the controller
		await controller.readConfiguration();

		// Return new controller
		return controller;
	},
	
	autodetect: async (port = 8442) => {
		// Autodetect Cybro controllers
		// Return list of Cybro controllers
		return await CybroComm.autodetect(port);
	}
}