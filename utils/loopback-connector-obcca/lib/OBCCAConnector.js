/**
 * Copyright 2015 IBM
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
*/
/**
 * Licensed Materials - Property of IBM
 * © Copyright IBM Corp. 2015
 */
var fs = require('fs');
var kdf = require('./kdf')
//crypto stuff
var jsrsa = require('jsrsasign');
var KEYUTIL = jsrsa.KEYUTIL;
var asn1 = jsrsa.asn1;
var elliptic = require('elliptic');
var sha3_256 = require('js-sha3').sha3_256;
var sha3_384 = require('js-sha3').sha3_384;
//grpc
var grpc = require("grpc");
var protoFile = __dirname + "/protos/ca.proto";
var Timestamp = grpc.load(__dirname + "/protos/google/protobuf/timestamp.proto").google.protobuf.Timestamp;
//internal state
var connector;

//Implement Loopback.io connector interface
exports.initialize = function(dataSource,callback) {

	//instantiate OBCCAConnector with dataSource.settings
	connector = new OBCCAConnector(dataSource.settings);
	
	//set dataSource.connector to connector
	dataSource.connector = connector;
    connector.dataSource = dataSource;
    
    connector.DataAccessObject = function() {};
    for (var m in OBCCAConnector.prototype) {
        var method = OBCCAConnector.prototype[m];
        if ('function' === typeof method) {
            connector.DataAccessObject[m] = method.bind(connector);
            for (var k in method) {
                connector.DataAccessObject[m][k] = method[k];
            }
        }
    };
    
    
    //check to see if being used within loopback framework
    if (dataSource.createModel && typeof dataSource.createModel == 'function') {
        dataSource.DataAccessObject = connector.DataAccessObject;
        //create models
        dataSource.createModel('RegisterUserRequest',
            {
                identity: {
                    type: "string",
                    id: true,
                    required: true
                },
                role: {
                    type: "number",
                    required: true
                }

            });
        dataSource.createModel('RegisterUserResponse',
            {
                identity: {
                    type: "string",
                    id: true
                },
                token: {
                    type: "string"
                }

            });
    };

	callback && callback();

};

exports.stop = function() {
    connector.stop();
};

exports.start = function() {
    connector.start();
};

function OBCCAConnector(settings) {
	
	this.name = 'OBCConnector';
    this.grpcServerAddress = settings.host + ":" + settings.port;
	this.grpcCredentials = grpc.credentials.createSsl();
    
    //load the protobuf definitions
    this.protos = grpc.load(protoFile).protos;
    this.ecaaClient = new this.protos.ECAA(this.grpcServerAddress,this.grpcCredentials);
    this.ecapClient = new this.protos.ECAP(this.grpcServerAddress,this.grpcCredentials);
    this.tcapClient = new this.protos.TCAP(this.grpcServerAddress,this.grpcCredentials);

	this.initialized = false;

};

//for testing
exports.OBCCAConnector = OBCCAConnector;


/**
 * @typedef RegisterUserResponse
 * @type Object
 * @property {string} identity Identity
 * @property {string} token One time token for the registered identity
 */

/**
 * Register a new user with membership services
 * @param {Object} UserRequest
 * @param {string} UserRequest.identity
 * @param {number} UserRequest.role
 * @return {RegisterUserResponse}
 */ 
OBCCAConnector.prototype.registerUser = function(userRequest,callback){
    
    var registerUserRequest = new this.protos.RegisterUserReq();
    registerUserRequest.setId({id: userRequest.identity});
    registerUserRequest.setRole(userRequest.role);
    this.ecaaClient.registerUser(registerUserRequest,function(err,token){
        if (err)
        {

            if (callback)
            {
                callback(err,null);
            }
        }
        else
        {

            if (callback)
            {
                console.log(userRequest.identity + ' | ' + token.tok.toString());
                callback(null,{identity: userRequest.identity, token:token.tok.toString()});
            }
        }
    })
};

/**
 * 
 */ 

/**
 * Retrieve the ECA root certificate
 * 
 */
OBCCAConnector.prototype.getECACertificate = function(callback){
    
    this.ecapClient.readCaCertificate(new this.protos.Empty(),function(err,cert){
        if (err)
        {

            if (callback)
            {
                callback(err,null);
            }
        }
        else
        {
            
            console.log('ECA Root Cert:\n',cert.cert.toString('base64'));
            callback();
        }
        
    });
    
};

/**
 * Retrieve enrollment certificates from the ECA
 * @param {Object} LoginRequest
 * @param {string} LoginRequest.identity
 * @param {string} LoginRequest.token
 */ 
OBCCAConnector.prototype.getEnrollmentCertificateFromECA = function(loginRequest,callback){
    var self = this;
    
    var timestamp = new Timestamp({seconds: Date.now()/1000,nanos: 0});

    //generate ECDSA keys
    var ecKeypair = KEYUTIL.generateKeypair("EC", "secp384r1");
    var spki = new asn1.x509.SubjectPublicKeyInfo(ecKeypair.pubKeyObj);
    
    var ecKeypair2 = KEYUTIL.generateKeypair("EC", "secp384r1");
    var spki2 = new asn1.x509.SubjectPublicKeyInfo(ecKeypair2.pubKeyObj);

    //var rsaPrivKey = new NodeRSA(fs.readFileSync(__dirname + '/rsa/private_key.pem','utf8'));
    //rsaPrivKey.setOptions({encryptionScheme:'pkcs1'});
    //var rsaPrivKey = new NodeRSA({b:2048});
    //rsaPrivKey.setOptions({encryptionScheme:'pkcs1'});
    //var rsaKey = new RSAKey();
    //rsaKey.readPrivateKeyFromPEMString(rsaPrivKey.exportKey('pkcs1-private-pem'));
    //var spki2 = new asn1.x509.SubjectPublicKeyInfo(rsaKey);
    //console.log((new asn1.x509.SubjectPublicKeyInfo(rsaKey)).getASN1Object().getEncodedHex())
    
    //create the proto message
    var eCertCreateRequest = new this.protos.ECertCreateReq();
    eCertCreateRequest.setTs(timestamp);
    eCertCreateRequest.setId({id: loginRequest.identity});
    eCertCreateRequest.setTok({tok:new Buffer(loginRequest.token)});
    //public signing key (ecdsa)
    var signPubKey = new this.protos.PublicKey(
        {
            type: this.protos.CryptoType.ECDSA,
            key: new Buffer(spki.getASN1Object().getEncodedHex(), 'hex')
        });
    eCertCreateRequest.setSign(signPubKey);
    //public encryption key (ecdsa)
    var encPubKey = new this.protos.PublicKey(
        {
            type: this.protos.CryptoType.ECDSA,
            key: new Buffer(spki2.getASN1Object().getEncodedHex(), 'hex')
        });   
    eCertCreateRequest.setEnc(encPubKey);
       
    self.createCertificatePair(eCertCreateRequest,function(err,eCertCreateResp){
        if (err)
        {
            if (callback)
            {
                callback(err,null);
            }
        }
        else
        {
            var cipherText = eCertCreateResp.tok.tok;
            //cipherText = ephemeralPubKeyBytes + encryptedTokBytes + macBytes
            //ephemeralPubKeyBytes = first ((384+7)/8)*2 + 1 bytes = first 97 bytes
            //hmac is sha3_384 = 48 bytes or sha3_256 = 32 bytes
            var ephemeralPublicKeyBytes = cipherText.slice(0,97);
            var encryptedTokBytes = cipherText.slice(97,cipherText.length - 32);
            console.log("encryptedTokBytes:\n",encryptedTokBytes);
            var macBytes = cipherText.slice(cipherText.length - 48);
            console.log("length = ",ephemeralPublicKeyBytes.length+encryptedTokBytes.length+macBytes.length);
            //console.log(rsaPrivKey.decrypt(eCertCreateResp.tok.tok));
            console.log('encrypted Tok: ',eCertCreateResp.tok.tok);
            console.log('encrypted Tok length: ',eCertCreateResp.tok.tok.length);
            //console.log('public key obj:\n',ecKeypair2.pubKeyObj);
            console.log('public key length: ',new Buffer(ecKeypair2.pubKeyObj.pubKeyHex,'hex').length);
            //console.log('private key obj:\n',ecKeypair2.prvKeyObj);
            console.log('private key length: ',new Buffer(ecKeypair2.prvKeyObj.prvKeyHex,'hex').length);
            
            
            
            var EC = elliptic.ec           
            var curve = elliptic.curves['p384'];
            var ecdsa = new EC(curve);
            
            //convert bytes to usable key object
            var ephPubKey = ecdsa.keyFromPublic(ephemeralPublicKeyBytes.toString('hex'),'hex');
            var encPrivKey = ecdsa.keyFromPrivate(ecKeypair2.prvKeyObj.prvKeyHex, 'hex');
            
            var secret = encPrivKey.derive(ephPubKey.getPublic());
            //console.log('secret: ',secret);
            //console.log('secret bits: ',secret.bitLength());
            //console.log('secret number: ',secret.toString(10));
            //console.log('secret array: ',secret.toArray());
            var aesKey = kdf.hkdf(secret.toArray(),256,null,null,'sha3-256');

            console.log('aesKey: ',aesKey);
            
            var decryptedTokBytes = kdf.aesCFBDecryt(aesKey,encryptedTokBytes);
            
            //console.log(decryptedTokBytes);
            console.log(decryptedTokBytes.toString());
            
            eCertCreateRequest.setTok({tok:decryptedTokBytes});
            eCertCreateRequest.setSig(null);
            
            var buf = eCertCreateRequest.toBuffer();
            //console.log('Proto raw buffer:\n');
            //console.log(JSON.stringify(buf));
            //console.log('\n\n');            
            //console.log('Hash:\n');
            //console.log(JSON.stringify(new Buffer(sha3_384(buf),'hex')));          
            
            //console.log(curve);
                    
            var signKey = ecdsa.keyFromPrivate(ecKeypair.prvKeyObj.prvKeyHex, 'hex');
            //console.log(new Buffer(sha3_384(buf),'hex'));
            var sig = ecdsa.sign(new Buffer(sha3_256(buf),'hex'), signKey);
            //console.log(sig3);
            
            eCertCreateRequest.setSig(new self.protos.Signature(
                {
                    type: self.protos.CryptoType.ECDSA,
                    r: new Buffer(sig.r.toString()),
                    s: new Buffer(sig.s.toString())
                }
                ));
            self.createCertificatePair(eCertCreateRequest, function (err, eCertCreateResp) {
                if (err) {
                    if (callback) {
                        callback(err, null);
                    }
                }
                else
                {
                    console.log(eCertCreateResp);
            
                    callback(ecKeypair.prvKeyObj.prvKeyHex,eCertCreateResp.certs.sign.toString('hex'));
                }
            });
        }
        
    });

};

OBCCAConnector.prototype.createCertificatePair = function(eCertCreateRequest, callback){
    
    this.ecapClient.createCertificatePair(eCertCreateRequest,function(err,eCertCreateResp){
        if (err)
        {
            console.log('error:\n',err);

            if (callback)
            {
                callback(err,null);
            }
        }
        else
        {
            callback(null,eCertCreateResp);
        }
        
    });
    
};

OBCCAConnector.prototype.tcaCreateCertificateSet = function(num, callback){
    var self = this;
    
    var timestamp = new Timestamp({seconds: Date.now()/1000,nanos: 0});
    
};

//remote registerUser
setRemoting(OBCCAConnector.prototype.registerUser, {
    description: 'Register a new user with the Certificate Authority',
    accepts: [
        { arg: 'RegisterUserRequest', type: 'RegisterUserRequest', description: 'Unique user to register', http: { source: 'body' } }
    ],
    returns: { arg: 'RegisterUserResponse', type: 'RegisterUserResponse', root: true },
    http: { verb: 'post', path: '/registerUser' }
});

//helper function to expose remote functions for loopback datasource / models
function setRemoting(fn, options) {
    options = options || {};
    for (var opt in options) {
        if (options.hasOwnProperty(opt)) {
            fn[opt] = options[opt];
        }
    }
    fn.shared = true;
};

function toArrayBuffer(buffer) {
    var ab = new ArrayBuffer(buffer.length);
    var view = new Uint8Array(ab);
    for (var i = 0; i < buffer.length; ++i) {
        view[i] = buffer[i];
    }
    return view;
};