/*jshint node:true */

var http = require('http'),
    https = require('https'),
    server = http.createServer(handler).listen(73331),
    path = require('path'),
    url = require('url'),
    gcm = require('node-gcm'),
    twit = require('twit'),
    low = require('lowdb'),
    db = low('db.json'),
    settingsdb = low('settings.json');


var settings = {
    gcmkey: null,
    profiles: []
};

function loadSettings(){
    var gcm = settingsdb('gcm').findLast().cloneDeep().value();
    var profiles = settingsdb('profiles').cloneDeep().value();
    if(gcm && gcm.key){
        settings.gcmkey = gcm.key;
    } else{
        throw new Error('No gcm key was specified');
    }
    if(profiles.length !== 0){
        profiles.forEach(function(profile){
            profile.Twit = new twit(profile.twitter);
            profile.stream = null;
        });
        settings.profiles = profiles;
    } else{
        console.log('No profile was specified');
    }
}
            
var sender = new gcm.Sender(settings.gcmkey);

//http handler
//
function handler(req, res) {
    var reqpath = url.parse(req.url).pathname;
    if (req.method === 'POST') {
        switch (reqpath) {
        case '/registergcm':
            checkRegisterReq(req, res, function(regid, username){
                register(req, res, regid, username);
            });
            break;
        case '/unregistergcm':
            checkUnregisterReq(req, res, function(regid){
                unregister(req, res, regid);
            });
            break;
        default:
            throwerr(res, 404, 'Endpoint not found');
        }
    } else {
        throwerr(res, 400);
    }
}

function checkRegisterReq(req, res, cb){
    getBody(req, function (data) {
        console.log(data.regid);
        if (!data) {
            throwerr(res, 415, 'No or invalid JSON');
            return;
        }
        if(!data.regid) {
            throwerr(res, 400, 'No registration id was given');
            return;
        }
        if (!req.headers.authorization) {
            throwerr(res, 401, 'Not authorized');
            return;
        }
        validateToken(req.headers.authorization, function (username) {
            if (!username) {
                throwerr(res, 401, 'Not authorized');
                return;
            }
            cb(data.regid, username);
        });
    });
}

function register(req, res, regid, userid) {
    db('users').remove({userid: userid});
    db('users').push({userid: userid,
                      regid: regid});
    res.writeHead(200);
    res.end('{}');
    updateTwitterStreams();
}

function checkUnregisterReq(req, res, cb) {
    getBody(req, function (data) {
        if (!data) {
            throwerr(res, 415, 'No or invalid JSON');
            return;
        }
        if (!data.regid) {
            throwerr(res, 400, 'No registration id was given');
            return;
        }
        var person = db('users').find({regid: data.regid}).value();
        if (person) {
            cb(data.regid);
        } else {
            throwerr(res, 400, 'User does not exist or has already been removed');
        }
    });
}

function unregister(req, res, regid) {
    db('users').remove({regid: regid});
    res.writeHead(200);
    res.end('{}');
    updateTwitterStreams();
}

function throwerr(res, errcode, text) {
    res.writeHead(errcode, {
        'Content-Type': 'text/plain'
    });
    res.end(errcode.toString() + (text || ''));
}

function getBody(req, cb) {
    var body = '';
    req.on('data', function (data) {
        body += data;

        // Too much POST data
        if (body.length > 1e6)
            req.connection.destroy();
    });
    req.on('end', function () {
        try{
            cb(JSON.parse(body));
        }
        catch(e){
            cb(false);
        }
    });
}

function validateToken(access_token, cb) {
    var options = {
        host: 'www.googleapis.com',
        path: '/oauth2/v2/userinfo',
        headers: {
            Host: 'www.googleapis.com',
            Authorization: access_token
        }
    };
    https.request(options, function (res) {
        if (res.statusCode !== 200) {
            cb(false);
            return;
        }
        var data = '';
        res.on('data', function (chunk) {
            data += chunk;
        });

        res.on('end', function () {
            cb(JSON.parse(data).email);
        });
    }).end();
}

//Twitter
//
function updateTwitterStreams(){
    settings.profiles.forEach(function(profile){
        var person = db('users').find({userid: profile.userid}).value();
        if (person) {
            if (!person.regid) {
                console.log(profile.userid + ' has no saved regid');
                profile.stream = null;
            } else if (!profile.stream) {
                
                profile.stream = profile.Twit.stream('user', {
                    with: 'followings'
                });
                profile.stream.on('connect', buildConnectCb(profile, person.regid));
                console.log(profile.Twit.getAuth());
            }
        } else {
            console.log(profile.userid + ' is not in the database yet.');
            profile.stream = null;
        }
    });
    
    function buildConnectCb(profile, regid){
        return function(){onTwitterStreamConnect(profile, regid);};
    }
}

function onTwitterStreamConnect(profile, regid){
    getTwitterId(profile, function(err, twid){
        if(err && profile.twid || !err){
            profile.twid = twid || profile.twid;
            console.log('Twitter connection for ' + profile.userid + ' established');
            handleTwitterStream(profile, regid);
        } else{
            console.log(err);
        }
    });
}

function handleTwitterStream(profile, regid) {
    profile.stream.on('tweet', function (tweet) {
        if (tweet.retweeted_status && tweet.retweeted_status.user.id_str === profile.twid) {
            //you got retweeted
            notify(regid,
                   profile.twid,
                   tweet.user.screen_name,
                   'type_retweet',
                   tweet.retweeted_status.text,
                   tweet.user.profile_image_url);
        } else {
            var me = false;
            tweet.entities.user_mentions.forEach(function (mention) {
                if (mention.id_str === profile.twid)
                    me = true;
            });

            if (me) {
                //you got mentioned
                notify(regid,
                       profile.twid,
                       tweet.user.screen_name,
                       'type_mention',
                       tweet.text,
                       tweet.user.profile_image_url);
            }
        }
    });

    profile.stream.on('direct_message', function (dm) {
        if (dm.direct_message.recipient.id_str === profile.twid) {
            //you got a direct message
            notify(regid,
                   profile.twid,
                   dm.direct_message.sender.screen_name,
                   'type_direct_message',
                   dm.direct_message.text,
                   dm.direct_message.sender.profile_image_url);
        }
    });

    profile.stream.on('follow', function (ev) {
        if (ev.source.id_str !== profile.twid) {
            //someone followed you
            notify(regid,
                   profile.twid,
                   ev.source.screen_name,
                   'type_new_follower',
                   '',
                   ev.source.profile_image_url
                   );
        }
    });

    profile.stream.on('favorite', function (ev) {
        if (ev.source.id_str !== profile.twid) {
            //someone favorited your tweet
            notify(regid,
                   profile.twid,
                   ev.source.screen_name,
                   'type_favorite',
                   ev.target_object.text,
                   ev.source.profile_image_url
                  );
        }
    });
}

function getTwitterId(profile, cb) {
    profile.Twit.get('account/verify_credentials',{skip_status: true}, function (err, data, response) {
        cb(err, data.id_str);
    });
}

//gcm
//
function notify(regid, data_account, data_fromuser, data_type, data_msg, data_image){
    var message = new gcm.Message({
        collapseKey: 'demo',
        delayWhileIdle: false,
        timeToLive: 3,
        data: {
            account: data_account,
            fromuser: data_fromuser,
            type: data_type,
            msg: data_msg,
            image: data_image
        }
    });
    sendNotification(message, regid);
}

function sendNotification(msg, regid) {
    sender.sendNoRetry(msg, [regid], function (err, result) {
        if (err) {
            console.log(err);
        }
        if (result) {
            //console.log(msg, result);
        }
    });
}

//init
//
loadSettings();
updateTwitterStreams();