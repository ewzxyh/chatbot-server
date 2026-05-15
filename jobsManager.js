
var winston = require('./config/winston');
var backgroundWorkers = require('./utils/backgroundWorkers');

class JobsManager {
    constructor(jobWorkerEnabled, geoService, botEvent, subscriptionNotifierQueued, botSubscriptionNotifier, updateLeadQueued, updateRequestSnapshotQueued) {
        this.geoService = geoService;
        this.botEvent = botEvent;
        // this.subscriptionNotifier = subscriptionNotifier;
        this.subscriptionNotifierQueued = subscriptionNotifierQueued;
        this.botSubscriptionNotifier = botSubscriptionNotifier;

        this.emailNotificatio = undefined;
        this.activityArchiver = undefined;
        this.whatsappWorker = undefined;
        this.multiWorkerQueue = undefined;

        this.jobWorkerEnabled = jobWorkerEnabled;
        // this.jobWorkerEnabled = false;
        // if (process.env.JOB_WORKER_ENABLED=="true" || process.env.JOB_WORKER_ENABLED == true) {
        //     this.jobWorkerEnabled = true;
        // }
        // winston.info("JobsManager jobWorkerEnabled: "+ this.jobWorkerEnabled);  

        this.updateLeadQueued = updateLeadQueued;
        this.updateRequestSnapshotQueued = updateRequestSnapshotQueued;
    }


    listen() {      
        winston.info("JobsManager listener started");  
        if (backgroundWorkers.disabled()) {
            return winston.info("Background workers disabled. Skipping JobsManager listeners");
        }
        if ( this.jobWorkerEnabled == true) {
           return winston.info("JobsManager jobWorkerEnabled is enabled. Skipping listeners");  
        }
        this.geoService.listen();
        
        // this.botEvent.listen(); // disabled

        // this.subscriptionNotifier.start();
        this.subscriptionNotifierQueued.start();

        this.updateLeadQueued.listen();

        if (this.updateRequestSnapshotQueued) {
            this.updateRequestSnapshotQueued.listen();
        }

        // this.botSubscriptionNotifier.start(); // disabled
    }

    listenEmailNotification(emailNotification) {      
        winston.info("JobsManager listenEmailNotification started");  
        if (backgroundWorkers.disabled()) {
            return winston.info("Background workers disabled. Skipping listener for Email Notification");
        }
        if ( this.jobWorkerEnabled == true) {
            return winston.info("JobsManager jobWorkerEnabled is enabled. Skipping listener for Email Notification");  
        }
        this.emailNotification = emailNotification;
        this.emailNotification.requestNotification.listen();
    }

    listenRoutingQueue(routingQueue) {
        winston.info("JobsManager routingQueue started");  
        if (backgroundWorkers.disabled()) {
            return winston.info("Background workers disabled. Skipping listener for routingQueue");
        }
        if ( this.jobWorkerEnabled == true) {
            return winston.info("JobsManager jobWorkerEnabled is enabled. Skipping listener for routingQueue");  
        }
        this.routingQueue = routingQueue;
        this.routingQueue.listen();
    }

    listenScheduler(scheduler) {
        winston.info("JobsManager scheduler started");  
        if (backgroundWorkers.disabled()) {
            return winston.info("Background workers disabled. Skipping listener for scheduler");
        }
        if ( this.jobWorkerEnabled == true) {
            return winston.info("JobsManager jobWorkerEnabled is enabled. Skipping listener for scheduler");  
        }
        this.scheduler = scheduler;
        this.scheduler.taskRunner.start();    
    }

    listenActivityArchiver(activityArchiver) {
        winston.info("JobsManager listenActivityArchiver started"); 
        if (backgroundWorkers.disabled()) {
            return winston.info("Background workers disabled. Skipping listener for Activity Archiver");
        }
        if ( this.jobWorkerEnabled == true) {
            return winston.info("JobsManager jobWorkerEnabled is enabled. Skipping listener for Activity Archiver");  
        } 
        this.activityArchiver = activityArchiver;
        this.activityArchiver.listen();
    }

    listenWhatsappQueue(whatsappQueue) {
        if (backgroundWorkers.disabled()) {
            return winston.info("Background workers disabled. Skipping listener for Whatsapp Queue");
        }
        console.log("JobsManager listenWhatsappQueue started");
        console.log("whatsappQueue is: ", whatsappQueue)
        if ( this.jobWorkerEnabled == true) {
            return winston.info("JobsManager jobWorkerEnabled is enabled. Skipping listener for Whatsapp Queue");  
        }
        // this.whatsappWorker = whatsappQueue;
        // this.whatsappQueue.listen(); // oppure codice
    }

    listenMultiWorker(multiWorkerQueue) {
        if (backgroundWorkers.disabled()) {
            return winston.info("Background workers disabled. Skipping listener for MultiWorker Queue");
        }
        console.log("JobsManager multiWorkerQueue started");
        console.log("multiWorkerQueue is: ", multiWorkerQueue)
        if (this.jobWorkerEnabled == true) {
            return winston.info("JobsManager jobWorkerEnabled is enabled. Skipping listener for MultiWorker Queue");  
        }
        this.multiWorkerQueue = multiWorkerQueue;
        this.multiWorkerQueue.startJobsWorker();
    }

    // listenTrainingQueue(trainingQueue) {
    //     console.log("JobsManager listenTrainingQueue started");
    //     console.log("trainingQueue is: ", trainingQueue)
    //     if (this.jobWorkerEnabled == true) {
    //         return winston.info("JobsManager jobWorkerEnabled is enabled. Skipping listener for Training Queue");  
    //     }
    // }
}


module.exports = JobsManager;
