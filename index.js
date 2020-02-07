"use strict";

var AWS = require('aws-sdk');

console.log("AWS Lambda SES Forwarder // @arithmetric // Version 4.2.0");

// Configure the S3 bucket and key prefix for stored raw emails, and the
// mapping of email addresses to forward from and to.
//
// Expected keys/values:
//
// - fromEmail: Forwarded emails will come from this verified address
//
// - subjectPrefix: Forwarded emails subject will contain this prefix
//
// - emailBucket: S3 bucket name where SES stores emails.
//
// - emailKeyPrefix: S3 key name prefix where SES stores email. Include the
//   trailing slash.
//
// - forwardMapping: Object where the key is the lowercase email address from
//   which to forward and the value is an array of email addresses to which to
//   send the message.
//
//   To match all email addresses on a domain, use a key without the name part
//   of an email address before the "at" symbol (i.e. `@example.com`).
//
//   To match a mailbox name on all domains, use a key without the "at" symbol
//   and domain part of an email address (i.e. `info`).
var defaultConfig = {
  fromEmail: "noreply@example.com",
  fromPrefix: "",
  subjectPrefix: "",
  emailBucket: "s3-bucket-name",
  emailKeyPrefix: "emailsPrefix/",
  forwardMapping: {
    "info@example.com": [
      "example.john@example.com",
      "example.jen@example.com"
    ],
    "abuse@example.com": [
      "example.jim@example.com"
    ],
    "@example.com": [
      "example.john@example.com"
    ],
    "info": [
      "info@example.com"
    ]
  }
};

/**
 * Parses the SES event record provided for the `mail` and `receipients` data.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.parseEvent = function(data) {
  // Validate characteristics of a SES event record.
  if (!data.event ||
      !data.event.hasOwnProperty('Records') ||
      data.event.Records.length !== 1 ||
      !data.event.Records[0].hasOwnProperty('eventSource') ||
      data.event.Records[0].eventSource !== 'aws:ses' ||
      data.event.Records[0].eventVersion !== '1.0') {
    data.log({message: "parseEvent() received invalid SES message:",
      level: "error", event: JSON.stringify(data.event)});
    return Promise.reject(new Error('Error: Received invalid SES message.'));
  }

  data.email = data.event.Records[0].ses.mail;
  data.recipients = data.event.Records[0].ses.receipt.recipients;
  return Promise.resolve(data);
};

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.transformRecipients = function(data) {
  var newRecipients = [];
  data.originalRecipients = data.recipients;
  data.recipients.forEach(function(origEmail) {
    var origEmailKey = origEmail.toLowerCase();
    if (data.config.forwardMapping.hasOwnProperty(origEmailKey)) {
      newRecipients = newRecipients.concat(
        data.config.forwardMapping[origEmailKey]);
      data.originalRecipient = origEmail;
    } else {
      var origEmailDomain;
      var origEmailUser;
      var pos = origEmailKey.lastIndexOf("@");
      if (pos === -1) {
        origEmailUser = origEmailKey;
      } else {
        origEmailDomain = origEmailKey.slice(pos);
        origEmailUser = origEmailKey.slice(0, pos);
      }
      if (origEmailDomain &&
          data.config.forwardMapping.hasOwnProperty(origEmailDomain)) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping[origEmailDomain]);
        data.originalRecipient = origEmail;
      } else if (origEmailUser &&
        data.config.forwardMapping.hasOwnProperty(origEmailUser)) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping[origEmailUser]);
        data.originalRecipient = origEmail;
      } else{

        // email user format: user@domain.com -> USER
        origEmailUser = origEmailUser.replace(/-/g, '_').toUpperCase();
        
        // domain format: @domain.com -> DOMAINCOM
        origEmailDomain = origEmailKey.slice(pos).replace(/(@|-|\.)/g, '').toUpperCase();
        
        console.log("origEmailUser " + origEmailUser);
        console.log("origEmailDomain " + origEmailDomain);
        
        if (origEmailUser && process.env.hasOwnProperty(origEmailUser)) {
          newRecipients = newRecipients.concat(process.env[origEmailUser]);
          data.originalRecipient = origEmail;
        }else if (origEmailDomain && process.env.hasOwnProperty(origEmailDomain)) {
          newRecipients = newRecipients.concat(process.env[origEmailDomain]);
          data.originalRecipient = origEmail;
        }else if(process.env.CATCHALL){
          newRecipients = newRecipients.concat(process.env.CATCHALL);
          data.originalRecipient = origEmail;
        }
        
      } 
    }
  });

  if (!newRecipients.length) {
    data.log({message: "Finishing process. No new recipients found for " +
      "original destinations: " + data.originalRecipients.join(", "),
      level: "info"});
    return data.callback();
  }

  data.recipients = newRecipients;
  return Promise.resolve(data);
};

/**
 * Fetches the message data from S3.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.fetchMessage = function(data) {
  // Copying email object to ensure read permission
  data.log({level: "info", message: "Fetching email at s3://" +
    data.config.emailBucket + '/' + data.config.emailKeyPrefix +
    data.email.messageId});
  return new Promise(function(resolve, reject) {
    data.s3.copyObject({
      Bucket: data.config.emailBucket,
      CopySource: data.config.emailBucket + '/' + data.config.emailKeyPrefix +
        data.email.messageId,
      Key: data.config.emailKeyPrefix + data.email.messageId,
      ACL: 'private',
      ContentType: 'text/plain',
      StorageClass: 'STANDARD'
    }, function(err) {
      if (err) {
        data.log({level: "error", message: "copyObject() returned error:",
          error: err, stack: err.stack});
        return reject(
          new Error("Error: Could not make readable copy of email."));
      }

      // Load the raw email from S3
      data.s3.getObject({
        Bucket: data.config.emailBucket,
        Key: data.config.emailKeyPrefix + data.email.messageId
      }, function(err, result) {
        if (err) {
          data.log({level: "error", message: "getObject() returned error:",
            error: err, stack: err.stack});
          return reject(
            new Error("Error: Failed to load message body from S3."));
        }
        data.emailData = result.Body.toString();
        return resolve(data);
      });
    });
  });
};

/**
 * Processes the message data.
 *    Changes: Create new message, discarding all old headers due to issues with some
 *             email processing systems (e.g. Microsoft Teams receiving emails).
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.processMessage = function(data) {
  var match = data.emailData.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m);
  var header = match && match[1] ? match[1] : data.emailData;
  var body = match && match[2] ? match[2] : '';

  //console.log('Orig Header: ' + header);
  //console.log('Orig Body: ' + body);

  var res, headers;

  if(data.config.fromPrefix){
    var tmp = "" + data.originalRecipients;
    res = tmp.match(/^.*@(.*),?.*?/m); 
    if (res) {
      headers = "From: "+data.config.fromPrefix+"@"+res[1]+"\r\n";
    }else{
      headers = "From: "+data.config.fromEmail+"\r\n";
    }    
  }else{
    headers = "From: "+data.config.fromEmail+"\r\n";
  }

  var replyto;
  //res = header.match(/^From: (.*(?:\r?\n\s+.*)*)/m);
  res = header.match(/^From: (.*)/m);    
  if (res) {
    headers += "Reply-To: "+res[1]+"\r\n";
    replyto=res[1];
  }else{
    headers += "Reply-To: "+data.config.fromEmail+"\r\n";
    replyto=data.config.fromEmail;
  }
  
  headers += "X-Original-To: "+data.originalRecipients+"\r\n";
  
  headers += "To: "+data.recipients+"\r\n";

  res = header.match(/^Subject: (.*)/m);    
  if (res) {
    headers += "Subject: "+data.config.subjectPrefix+res[1]+"\r\n";
  }else{
    headers += "Subject: "+data.config.subjectPrefix+" (FROM: "+replyto+" TO: "+data.originalRecipients+")\r\n";
  }
  
  res = header.match(/Content-Type:.+\s*boundary.*/);
  if (res) {
    headers += res[0]+"\r\n";
  }
  else {
      res = header.match(/^Content-Type:(.*)/m);
      if (res) {
          headers += res[0]+"\r\n";
      }
  }

  res = header.match(/^Content-Transfer-Encoding:(.*)/m);
  if (res) {
      headers += res[0]+"\r\n";
  }

  res = header.match(/^MIME-Version:(.*)/m);
  if (res) {
      headers += res[0]+"\r\n";
  }

  res = body.match(/(<\/body[\s\S]*>)/im);
  if ( res ){
      replyto = replyto.replace('<','&lt;');
      replyto = replyto.replace('>','&gt;');
      res = body.match(/(<body[^>]*>)/im);
      if ( res ){
          body = body.replace(/(<body[^>]*>)/i, "" + res[0] + "\r\n(FROM: "+replyto+" TO: "+data.originalRecipients+")\r\n");
      }else{
          body = body.replace(/<\/body[\s\S]*>/i, "\r\n(FROM: "+replyto+" TO: "+data.originalRecipients+")\r\n</body>");
      }
  }else{
      res = body.match(/^Content-Transfer-Encoding: quoted-printable/m);
      if(res){
          body = body.replace(/Content-Transfer-Encoding: quoted-printable/i, "Content-Transfer-Encoding: quoted-printable\r\n\r\n(FROM: "+replyto+" TO: "+data.originalRecipients+")\r\n");
      }else{
          body = body +  "\r\n(FROM: "+replyto+" TO: "+data.originalRecipients+")\r\n";
      }
  }

  var splitEmail = body.split("\r\n\r\n");

  var email = headers+"\r\n"+splitEmail.join("\r\n\r\n");

  data.emailData = email;
  return Promise.resolve(data);
};

/**
 * Send email using the SES sendRawEmail command.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.sendMessage = function(data) {
  var params = {
    RawMessage: {
      Data: data.emailData
    }
  };
  data.log({level: "info", message: "sendMessage: Sending email via SES. " +
    "Original recipients: " + data.originalRecipients.join(", ") +
    ". Transformed recipients: " + data.recipients.join(", ") + "."});
  return new Promise(function(resolve, reject) {
    data.ses.sendRawEmail(params, function(err, result) {
      if (err) {
        data.log({level: "error", message: "sendRawEmail() returned error.",
          error: err, stack: err.stack});
        return reject(new Error('Error: Email sending failed.'));
      }
      data.log({level: "info", message: "sendRawEmail() successful.",
        result: result});
      resolve(data);
    });
  });
};

/**
 * Handler function to be invoked by AWS Lambda with an inbound SES email as
 * the event.
 *
 * @param {object} event - Lambda event from inbound email received by AWS SES.
 * @param {object} context - Lambda context object.
 * @param {object} callback - Lambda callback object.
 * @param {object} overrides - Overrides for the default data, including the
 * configuration, SES object, and S3 object.
 */
exports.handler = function(event, context, callback, overrides) {
  var steps = overrides && overrides.steps ? overrides.steps :
  [
    exports.parseEvent,
    exports.transformRecipients,
    exports.fetchMessage,
    exports.processMessage,
    exports.sendMessage
  ];
  var data = {
    event: event,
    callback: callback,
    context: context,
    config: overrides && overrides.config ? overrides.config : defaultConfig,
    log: overrides && overrides.log ? overrides.log : console.log,
    ses: overrides && overrides.ses ? overrides.ses : new AWS.SES(),
    s3: overrides && overrides.s3 ?
      overrides.s3 : new AWS.S3({signatureVersion: 'v4'})
  };
  Promise.series(steps, data)
    .then(function(data) {
      data.log({level: "info", message: "Process finished successfully."});
      return data.callback();
    })
    .catch(function(err) {
      data.log({level: "error", message: "Step returned error: " + err.message,
        error: err, stack: err.stack});
      return data.callback(new Error("Error: Step returned error."));
    });
};

Promise.series = function(promises, initValue) {
  return promises.reduce(function(chain, promise) {
    if (typeof promise !== 'function') {
      return Promise.reject(new Error("Error: Invalid promise item: " +
        promise));
    }
    return chain.then(promise);
  }, Promise.resolve(initValue));
};
