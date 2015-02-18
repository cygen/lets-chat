'use strict';

var _ = require('lodash'),
    moment = require('moment'),
    Stanza = require('node-xmpp-core').Stanza,
    MessageProcessor = require('./../msg-processor'),
    settings = require('./../../config'),
    helper = require('./../helper'),
    bcrypt = require('bcryptjs');

module.exports = MessageProcessor.extend({

    if: function() {
        return this.toARoom &&
               !this.request.type &&
               this.request.name === 'presence';
    },

    then: function(cb) {
        var toParts = this.request.attrs.to.split('/'),
            roomUrl = toParts[0],
            nickname = toParts[1],
            roomSlug = roomUrl.split('@')[0],
            connection = this.client.conn;

        // TODO: Do we need to track nickname for each individual room?
        this.connection.nickname = nickname;

        this.core.rooms.slug(roomSlug, function(err, room) {
            if (err) {
                return cb(err);
            }

            if (room) {
                return this.checkPassword(room, cb);(room, cb);
            }

            if (!settings.xmpp.roomCreation) {
                return this.cantCreateRoom(roomSlug, cb);
            }

            this.createRoom(roomSlug, function(err, room) {
                if (err) {
                    return cb(err);
                }
                this.checkPassword(room, cb);(room, cb);
            }.bind(this));

        }.bind(this));
    },

    createRoom: function(roomSlug, cb) {
        var password = this.getPassword();
        var options = {
            owner: this.connection.user.id,
            name: roomSlug,
            slug: roomSlug,
            description: '',
            password: password
        };
        if(!settings.rooms.passwords) {
            options.password = undefined;
        }
        this.core.rooms.create(options, cb);
    },

    cantCreateRoom: function(roomSlug, cb) {
        var presence = this.Presence({
            from: helper.getRoomJid(roomSlug, 'admin'),
            type: 'error'
        });

        presence.c('x', {
            xmlns:'http://jabber.org/protocol/muc'
        });

        presence.c('error', {
            by: helper.getRoomJid(roomSlug),
            type: 'cancel'
        }).c('not-allowed', {
            xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas'
        });

        cb(null, presence);
    },

    _getXNode: function() {
        if(!this.xNode) {
            this.xNode = _.find(this.request.children, function(child) {
                return child.name === 'x';
            });
        }
        return this.xNode;
    },

    getHistoryNode: function() {
        var xNode = this._getXNode();
        if (xNode) {
            return _.find(xNode.children, function(child) {
                return child.name === 'history';
            });
        }
    },

    getPassword: function() {
        var xNode = this._getXNode();
        if (xNode) {
            var passwordNode = _.find(xNode.children, function(child) {
                return child.name === 'password';
            });
            if(passwordNode && passwordNode.children) {
                return passwordNode.children[0];
            }
        }
    },

    checkPassword: function(room, cb) {
        if(!!room.password) {
            var password = this.getPassword();
            if(!password) {
                return this.sendErrorPassword(room, cb);
            }
            bcrypt.compare(password, room.password, function(err, isMatch) {
                if(err) {
                    return cb(err);
                }
                if(!!isMatch) {
                    this.handleJoin(room, cb);
                } else {
                    this.sendErrorPassword(room, cb);
                }
            }.bind(this));
        } else {
            this.handleJoin(room, cb);
        }
    },

    sendErrorPassword: function(room, cb) {
        var connection = this.client.conn;
        var username = connection.user.username;

        //from http://xmpp.org/extensions/xep-0045.html#enter-pw
        var presence = this.Presence({
            type: 'error'
        });

        presence
            .c('x', {
                xmlns:'http://jabber.org/protocol/muc'
            });
        presence
            .c('error', {
                type: 'auth',
                by: helper.getRoomJid(room.slug)
            })
            .c('not-authorized', {
                xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas'
            });

        return cb(null, presence);
    },

    handleJoin: function(room, cb) {
        var username = this.connection.user.username;

        var proom = this.core.presence.rooms.get(room._id);
        var usernames = proom ? proom.getUsernames() : [];

        // User's own presence must be last - and be their nickname
        var i = usernames.indexOf(username);
        if (i > -1) {
            usernames.splice(i, 1);
        }
        usernames.push(this.connection.nickname);

        var presences = usernames.map(function(username) {

            var presence = this.Presence({
                from: helper.getRoomJid(room.slug, username)
            });

            presence
                .c('x', {
                    xmlns:'http://jabber.org/protocol/muc#user'
                })
                .c('item', {
                    jid: helper.getUserJid(username),
                    affiliation: 'none',
                    role: 'participant'
                });

            return presence;

        }, this);

        var subject = this.Message({
            type: 'groupchat'
        });

        subject.c('subject').t(room.name + ' | ' + room.description);

        var historyNode = this.getHistoryNode();

        if (!historyNode ||
            historyNode.attrs.maxchars === 0 ||
            historyNode.attrs.maxchars === '0') {
                // Send no history
                this.core.presence.join(this.connection, room._id, room.slug);
                return cb(null, presences, subject);
        }

        var query = {
            room: room._id
        };

        if (historyNode.attrs.since) {
            query.since = moment(historyNode.attrs.since).utc().toDate();
        }

        if (historyNode.attrs.seconds) {
            query.since = moment()
                .subtract(historyNode.attrs.since, 'seconds')
                .utc()
                .toDate();
        }

        if (historyNode.attrs.maxstanzas) {
            query.take = historyNode.attrs.maxstanzas;
        }

        this.core.messages.list(query, function(err, messages) {

            messages.reverse();

            var msgs = messages.map(function(msg) {

                var stanza = new Stanza.Message({
                    id: msg._id,
                    type: 'groupchat',
                    to: helper.getRoomJid(room.slug),
                    from: helper.getRoomJid(room.slug, msg.owner.username)
                });

                stanza.c('body').t(msg.text);

                stanza.c('delay', {
                    xmlns: 'urn:xmpp:delay',
                    from: helper.getRoomJid(room.slug),
                    stamp: msg.posted.toISOString()
                });

                stanza.c('addresses', {
                    xmlns: 'http://jabber.org/protocol/address'
                }).c('address', {
                    type: 'ofrom',
                    jid: helper.getUserJid(msg.owner.username)
                });

                return stanza;

            }, this);

            this.core.presence.join(this.connection, room._id, room.slug);
            cb(null, presences, msgs, subject);

        }.bind(this));
    }

});
