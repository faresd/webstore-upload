var Q = require('q'),
    https = require('https'),
    path = require('path'),
    url = require('url'),
    fs = require('fs'),
    http = require('http'),
    util = require('util'),
    open = require('open'),
    _ = require('lodash'),
    glob = require('glob');

var accounts;
var extensions;

module.exports = function webstore_upload(uploadOptions, onComplete) {

    extensions = uploadOptions.extensions;
    accounts = uploadOptions.accounts;
    var tasks = uploadOptions.uploadExtensions || [];
    var extensionsToUpload = tasks.length ? _.pick(extensions, tasks) : extensions;

    //calculate tasks for accounts that we want to use
    var accountsTasksToUse = _.uniq( _.map( extensionsToUpload, function (extension) {

        var name = (extension.account || 'default');
        var account = accounts[ name ];

        var tokenStrategy = {};
        tokenStrategy.name = name;

        // If a `refresh_token` exists in the config then use it instead of prompting the user
        tokenStrategy.tokenFn = account.refresh_token !== undefined
            ? refresh_account_token
            : get_account_token;

        return Q.Promise(function(resolve, reject){
            return resolve(tokenStrategy.tokenFn(name));
        });
    }) );

    Q.all(accountsTasksToUse)
        .then(function(values){
            tasks.forEach(function(extension) {
                uploading(extension);
            });
        })
        .catch(function (err) {
            console.error('err: ', err);
        });

    // Get token for account
    function get_account_token(accountName){
        //prepare account for inner function
        var account = accounts[ accountName ];
        account['name'] = accountName;

        return Q.Promise(function (resolve, reject) {
            var getTokenFn = account['cli_auth'] ? getTokenForAccountCli : getTokenForAccount;

            getTokenFn(account, function (error, token) {
                if (error !== null) {
                    console.log('Error');
                    return reject(error);
                }
                //set token for provided account
                console.log('token: ', token);
                accounts[accountName].token = token;
                return resolve();
            });
        });
    }

    // Refresh token for account
    function refresh_account_token(accountName){
        //prepare account for inner function
        var account = accounts[ accountName ];
        account['name'] = accountName;

        return Q.Promise(function (resolve, reject) {
            console.log('Refreshing access token.');
            var post_data = util.format('client_id=%s' +
                '&client_secret=%s' +
                '&refresh_token=%s' +
                '&grant_type=refresh_token',
                account.client_id,
                account.client_secret,
                account.refresh_token);

            var req = https.request({
                host : 'accounts.google.com',
                path : '/o/oauth2/token',
                method : 'POST',
                headers : {
                    'Content-Type' : 'application/x-www-form-urlencoded',
                    'Content-Length' : post_data.length
                }
            }, function (res) {

                res.setEncoding('utf8');
                var response = '';
                res.on('data', function (chunk) {
                    response += chunk;
                });
                res.on('end', function () {
                    var obj = JSON.parse(response);
                    if (obj.error) {
                        console.log('Error: during access token request');
                        console.log(response);
                        return reject(obj.error);
                    } else {
                        //var token = obj.access_token;
                        //set token for provided account
                        accounts[accountName].token = obj.access_token;
                        return resolve();
                    }
                });
            });

            req.on('error', function (e) {
                console.log('Something went wrong', e.message);
                return reject(e);
            });

            req.write(post_data);
            req.end();
        });
    }

    // uploading with token
    function uploading(extensionName){
        var promises = [];
        var uploadConfig;
        var accountName;

        if (extensionName) {
            uploadConfig = extensionsToUpload[extensionName];
            accountName = uploadConfig.account || 'default';

            uploadConfig['name'] = extensionName;
            uploadConfig['account'] = accounts[accountName];
            var p = handleUpload(uploadConfig);
            promises.push(p);
        } else {
            _.each(extensionsToUpload, function (extension, extensionName) {
                var uploadConfig = extension;
                var accountName = extension.account || 'default';

                uploadConfig['name'] = extensionName;
                uploadConfig['account'] = accounts[accountName];
                var p = handleUpload(uploadConfig);
                promises.push(p);
            });
        }

        return Q.allSettled(promises).then(function (results) {
            var isError = false;
            var values = [];
            results.forEach(function (result) {
                if (result.state === 'fulfilled') {
                    values.push( result.value );
                } else {
                    isError = result.reason;
                }
            });

            if ( isError ) {
                console.log('================');
                console.log(' ');
                console.log('Error while uploading: ', isError);
                console.log(' ');
                Q.reject(new Error('Error while uploading: ', isError));
            } else {
                try {
                    onComplete(values, 'ahu ahu');
                } catch (e) {
                    return Q.reject(new Error(e.stack));
                }
                Q();
            }
        });
    }

    //upload zip
    function handleUpload( options ){

        var d = Q.defer();
        var filePath, readStream, zip;
        var doPublish = false;
        if( typeof options.publish !== 'undefined' ){
            doPublish = options.publish;
        }else if( typeof options.account.publish !== 'undefined' ){
            doPublish = options.account.publish;
        }
        //updating existing
        console.log('================');
        console.log(' ');
        console.log('Updating app ('+ options.name +'): ', options.appID);
        console.log(' ');

        zip = options.zip;
        if( fs.statSync( zip ).isDirectory() ){
            zip = getRecentFile( zip );
        }
        filePath = path.resolve(zip);

        var req = https.request({
            method: 'PUT',
            host: 'www.googleapis.com',
            path: util.format('/upload/chromewebstore/v1.1/items/%s', options.appID),
            headers: {
                'Authorization': 'Bearer ' + options.account.token,
                'x-goog-api-version': '2'
            }
        }, function(res) {
            res.setEncoding('utf8');
            var response = '';
            res.on('data', function (chunk) {
                response += chunk;
            });
            res.on('end', function () {
                var obj = JSON.parse(response);
                if( obj.uploadState !== 'SUCCESS' ) {
                    // console.log('Error while uploading ZIP', obj);
                    d.reject(obj.error ? obj.error.message : obj);
                }else{
                    console.log(' ');
                    console.log('Uploading done ('+ options.name +')' );
                    console.log(' ');
                    if( doPublish ){
                        publishItem( options ).then(function () {
                            d.resolve({
                                fileName        : zip,
                                extensionName   : options.name,
                                extensionId     : options.appID,
                                published       : true
                            });
                        });
                    }else{
                        d.resolve({
                            fileName        : zip,
                            extensionName   : options.name,
                            extensionId     : options.appID,
                            published       : false
                        });
                    }
                }
            });
        });

        req.on('error', function(e){
            console.error('Something went wrong ('+ options.name +')', e.message);
            d.reject('Something went wrong ('+ options.name +')');
        });

        console.log('Path to ZIP ('+ options.name +'): ', filePath);
        console.log(' ');
        console.log('Uploading '+ options.name +'..');
        readStream = fs.createReadStream(filePath);

        readStream.on('end', function(){
            req.end();
        });

        readStream.pipe(req);

        return d.promise;
    }

    //make item published
    function publishItem(options){
        var d = Q.defer();
        console.log('Publishing ('+ options.name +') ' + options.appID + '..');

        var url = util.format('/chromewebstore/v1.1/items/%s/publish', options.appID);
        if(options.publishTarget)
            url += '?publishTarget=' + options.publishTarget;

        var req = https.request({
            method: 'POST',
            host: 'www.googleapis.com',
            path: url,
            headers: {
                'Authorization': 'Bearer ' + options.account.token,
                'x-goog-api-version': '2',
                'Content-Length': '0'
            }
        }, function(res) {
            res.setEncoding('utf8');
            var response = '';
            res.on('data', function (chunk) {
                response += chunk;
            });
            res.on('end', function () {
                var obj = JSON.parse(response);
                if( obj.error ){
                    console.log('Error while publishing ('+ options.name +'). Please check configuration at Developer Dashboard', obj);
                }else{
                    console.log('Publishing done ('+ options.name +')');
                    console.log(' ');
                }
                d.resolve();
            });
        });

        req.on('error', function(e){
            console.error('Something went wrong ('+ options.name +')', e.message);
            d.resolve();
        });
        req.end();

        return d.promise;
    }

    //return most recent changed file in directory
    function getRecentFile( dirName ){
        var files = glob.sync( dirName + '/*.zip', { nodir: true}),
            mostRecentFile,
            currentFile;

        if( files.length ){
            for( var i = 0; i < files.length; i++ ){
                currentFile = files[i];
                if( !mostRecentFile ){
                    mostRecentFile = currentFile;
                }else{
                    if( fs.statSync( currentFile ).mtime > fs.statSync( mostRecentFile ).mtime ){
                        mostRecentFile = currentFile;
                    }
                }
            }
            return mostRecentFile;
        }else{
            return false;
        }
    }

    // Request access token from code
    function requestToken( account, redirectUri, code, cb ){
        console.log('code', code);
        var post_data = util.format('client_id=%s&client_secret=%s&code=%s&grant_type=authorization_code&redirect_uri=%s', account.client_id, account.client_secret, code, redirectUri),
            req = https.request({
                host: 'accounts.google.com',
                path: '/o/oauth2/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': post_data.length
                }
            }, function(res) {

                res.setEncoding('utf8');
                var response = '';
                res.on('data', function (chunk) {
                    response += chunk;
                });
                res.on('end', function () {
                    var obj = JSON.parse(response);
                    if(obj.error){
                        console.log('Error: during access token request');
                        console.log( response );
                        cb( new Error() );
                    }else{
                        if (!account.refresh_token) {
                            console.log('To make future uploads work without needing the browser, add this to your account settings:\n  refresh_token: "' + obj.refresh_token + '"');
                        }
                        cb(null, obj.access_token);
                    }
                });
            });

        req.on('error', function(e){
            console.log('Something went wrong', e.message);
            cb( e );
        });

        req.write( post_data );
        req.end();
    }

    // get OAuth token using ssh-friendly cli
    function getTokenForAccountCli( account, cb ){
        var redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
        var codeUrl = util.format('https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=%s&redirect_uri=%s', account.client_id, redirectUri);
        var readline = require('readline');

        var rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });


        rl.question(util.format('Please open %s and enter code: ', codeUrl), function(code) {
            rl.close();
            requestToken(account, redirectUri, code, cb);
        });
    }

    //get OAuth token
    function getTokenForAccount( account, cb ){
        var exec = require('child_process').exec,
            port = 14809,
            callbackURL = util.format('http://localhost:%s', port),
            server = http.createServer(),
            codeUrl = util.format('https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=%s&redirect_uri=%s', account.client_id, callbackURL);

        console.log(' ');
        console.log('Authorization for account: ' + account.name);
        console.log('================');

        //due user interaction is required, we creating server to catch response and opening browser to ask user privileges
        server.on('connection', function(socket) {
            //reset Keep-Alive connections in order to quick close server
            socket.setTimeout(1000);
        });
        server.on('request', function(req, res){
            var code = url.parse(req.url, true).query['code'];  //user browse back, so code in url string
            if( code ){
                res.end('Got it! Authorizations for account "' + account.name + '" done. Check your console for new details. Tab now can be closed.');
                server.close(function () {
                    requestToken( account, callbackURL, code, cb );
                });
            }else{
                res.end('<a href="' + codeUrl + '">Please click here and allow access for account "' + account.name + '", to continue uploading..</a>');
            }
        });
        server.listen( port, 'localhost' );

        console.log(' ');
        console.log('Opening browser for authorization.. Please confirm privileges to continue..');
        console.log(' ');
        console.log(util.format('If the browser didn\'t open within a minute, please visit %s manually to continue', callbackURL));
        console.log(' ');

        open(codeUrl);


    }
};