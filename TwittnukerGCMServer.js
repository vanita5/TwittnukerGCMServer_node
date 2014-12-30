/*jshint node:true */

var http = require('http'),
    https = require('https'),
    path = require('path'),
    url = require('url'),
    gcm = require('node-gcm'),
    mongoose = require('mongoose'),
    Schema = mongoose.Schema,
    twit = require('twit');


var settings = {
    mongoadress: 'mongodb://tgcms:parkbank@localhost:21004/tgcms',
    
    gcmkey: 'XXX',
    
    profiles: {
        'mail@example.com': {
            twid: '000000000', //twitter user id
            Twit: new twit({
                'consumer_key': '',
                'consumer_secret': '',
                'access_token': '',
                'access_token_secret': ''
            }),
            stream: null
        }
    }
};


//database init
//

var userSchema = new Schema({
    userid: String,
    regid: String
});

var User = mongoose.model('User', userSchema),
    db = mongoose.connection;

mongoose.connect(settings.mongoadress);

//gcm
//
var sender = new gcm.Sender(settings.gcmkey);



//http handler
//
function handler(req, res) {
    console.log(req);
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

function register(req, res, regid, username) {
    User.remove({userid: username}, function (err) {
        if (err) {
            console.log(err);
            throwerr(res, 500, 'Server Error');
            return;
        }
        var thisuser = new User({
            userid: username,
            regid: regid
        });
        thisuser.save(function (err, ret) {
            updateTwitterStreams();
            if (err) {
                console.log(err);
                throwerr(res, 500, 'Server Error');
                return;
            } else {    
                res.writeHead(200);
                res.end('{}');
            }
        });
    });
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
        User.findOne({regid: data.regid}, 'regid', function (err, person) {
            if (person) {
                cb(data.regid);
            } else {
                throwerr(res, 400, 'User does not exist or has already been removed');
            }
        });
    });
}

function unregister(req, res, regid) {
    User.remove({regid: regid}, function (err) {
        if (err) {
            console.log(err);
            throwerr(res, 500, 'Server Error');
            return;
        } else {
            res.writeHead(200);
            res.end('{}');
            updateTwitterStreams();
        }
    });
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

var server = http.createServer(handler);

db.on('error', console.error.bind(console, 'connection error:'));

db.once('open', function () {
    console.log('connected to database');
    //start http server    
    server.listen(73331);
    //init all twitter streams
    updateTwitterStreams();
});

//Twitter Streams
//
function updateTwitterStreams(){
    for (var userid in settings.profiles) {
        var profile = settings.profiles[userid];
        User.findOne({
            userid: userid
        }, 'regid', buildDbCb(userid, profile));
    }
    
    function buildDbCb(userid, profile) {
        return function(err, person){dbCallback(err, person, userid, profile);};
    }    
    
    function dbCallback(err, person, userid, profile) {
        if (err) {
            console.log(err);
            profile.stream = null;
        } else if (person) {
            if (!person.regid) {
                profile.stream = null;
            } else if (!profile.stream) {
                profile.stream = profile.Twit.stream('user', {
                    with: 'followings'
                });
                profile.stream.on('connect', buildConnectCb(userid, person.regid, profile));
            }
        } else {
            console.log(profile.userid + ' is not in the database yet.');
            profile.stream = null;
        }

    }
    
    function buildConnectCb( userid, regid, profile){
        return function(){onTwitterStreamConnect(userid, regid, profile);};
    }
}

function onTwitterStreamConnect(userid, regid, profile){
    console.log('Twitter connection for ' + userid + ' established');
    handleTwitterStream(profile, regid);
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
