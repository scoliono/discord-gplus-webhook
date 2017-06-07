#!/usr/bin/env node
const request = require("request")
, fs = require("fs")
, xpath = require("xpath")
, dom = require("xmldom").DOMParser
, queue = require("async/queue")
, colors = require("colors")
, config = require("./config.json");

// Converts "8w" into a date from 8 weeks ago in JSON format
function parse_formatted_date(date_str)
{
    let num = date_str.match(/^(\d+)(?:[smhdwy])$/)[1];
    let char = date_str.match(/^(?:\d+)([smhdwy])$/)[1];

    let new_date = new Date();
    switch (char)
    {
        case 'd':
            new_date.setDate(new_date.getDate()-num);
            break;
        case 'w':
            new_date.setDate(new_date.getDate()-num*7);
            break;
        default:
            // G+ doesn't actually go past weeks
    }

    // We actually don't care about the timestamp. Just the date.
    new_date.setHours(0);
    new_date.setMinutes(0);
    new_date.setSeconds(0);
    new_date.setMilliseconds(0);

    return new_date.toJSON();
}

// Sends the webhook, given the information for one post
function webhook(post)
{
    request({
        url: config.webhook,
        method: "POST",
        json: {
            "embeds": [
                post
            ]
        }
    }, (err, res, body) => {
        if (err)
        {
            console.error("["+ new Date().toISOString() +"] Posting webhook failed:", err);
        }
        console.log(colors.cyan("["+ new Date().toISOString() +"] Got status code "+ res.statusCode +" for "+ post.title));
    });
}

// Checks for posts, gets the important info about them, then sends any new ones as webhooks
function check_for_posts(community, stream)
{
    request("https://plus.google.com/communities/"+ community + (stream ? "/stream/"+ stream : ""), (err, res, body) => {
        if (!err)
        {
            if (res && res.statusCode === 200)
            {
                let conf_posts = [];

                let doc = new dom({
                    errorHandler: {
                        // Mute those annoying warnings. We get it, Google sucks at writing proper HTML.
                        warning: null
                    }
                }).parseFromString(body); // for some reason specifying "text/html" mime type breaks everything
                let posts = xpath.select("//div[contains(@class, 'Ihwked') and contains(@class, 'hE2QI')]", doc);

                posts.forEach(e => {
                    // Gets all the info about a post using nothing but xpath
                    let author = {
                        "name": xpath.select1("div[contains(@class, 'dzuq1e')]/div[@class='nMlfCf']/div[@class='Cd5D8b']/div[@class='xHn24c']/a/text()", e).data,
                        "url": xpath.select1("div[contains(@class, 'dzuq1e')]/a[contains(@class, 'X1U4Ie')]/@href", e).value.replace(".", "https://plus.google.com"),
                        "icon_url": xpath.select1("div[contains(@class, 'dzuq1e')]/a[contains(@class, 'X1U4Ie')]/img/@src", e).value
                    };

                    // 2 cases: regular, pinned posts
                    let url = xpath.select1("div[contains(@class, 'dzuq1e')]/div[@class='nMlfCf']/div[@class='eRzjb']/a[@class='qXj2He']/@href", e) ? xpath.select1("div[contains(@class, 'dzuq1e')]/div[@class='nMlfCf']/div[@class='eRzjb']/a[@class='qXj2He']/@href", e).value : xpath.select1("div[contains(@class, 'dzuq1e')]/div[@class='nMlfCf']/div[@class='eRzjb']/div[@class='DsIcbd']/a[@class='QXSTae']/@href", e).value;
                    let formatted_date = xpath.select1("div[contains(@class, 'dzuq1e')]/div[@class='nMlfCf']/div[@class='eRzjb']/a[@class='qXj2He']/span/text()", e) ? xpath.select1("div[contains(@class, 'dzuq1e')]/div[@class='nMlfCf']/div[@class='eRzjb']/a[@class='qXj2He']/span/text()", e).data : "0d";

                    // Don't question it.
                    // Can either be the textual part of a regular post, the *new* text when resharing a post, or have no text at all.
                    let comment = xpath.select1("div[@class='ELUvyf']/div/div/div/text()", e) ? xpath.select1("div[@class='ELUvyf']/div/div/div/text()", e).data : (xpath.select1("div[@class='WIyZac']/div/div/text()", e) ? xpath.select1("div[@class='WIyZac']/div/div/text()", e).data : (xpath.select1("div[@class='tjHUud']/div[@class='RriDEe']/div[contains(@class, 'ahil4d')]/span/text()", e) ? xpath.select1("div[@class='tjHUud']/div[@class='RriDEe']/div[contains(@class, 'ahil4d')]/span/text()", e).data : ""));

                    let image = {
                        // This line is so long because of the different ways images can appear on a post:
                        // The image can be an attachment, the post can be a reshare where the OP had an image attachment, the post can be a link with an image, the post can be a reshared link with an image
                        // Albums/reshares of albums are *not* covered currently.
                        // If there is no image attributed to the post, default to the community banner.
                        "url": xpath.select1("div[@class='tjHUud']/div[@class='njiUWc']/div/div/div/div/div/img/@src", e) ? xpath.select1("div[@class='tjHUud']/div[@class='njiUWc']/div/div/div/div/div/img/@src", e).value : (xpath.select1("div[@jsname='MTOxpb']/div/a/div[@class='rr9Dof']/div[@class='E68jgf']/img/@src", e) ? xpath.select1("div[@jsname='MTOxpb']/div/a/div[@class='rr9Dof']/div[@class='E68jgf']/img/@src", e).value : (xpath.select1("div[@class='tjHUud']/div[@class='njiUWc']/div/a/div[@class='rr9Dof']/div[@class='E68jgf']/img/@src", e) ? xpath.select1("div[@class='tjHUud']/div[@class='njiUWc']/div/a/div[@class='rr9Dof']/div[@class='E68jgf']/img/@src", e).value : (xpath.select1("div[@jsname='MTOxpb']/div/div/div/div/div/img/@src", e) ? xpath.select1("div[@jsname='MTOxpb']/div/div/div/div/div/img/@src", e).value : config.default_banner))),
                    };

                    // so that discord won't complain about our image URLs not specifying a protocol
                    image.url = image.url.replace(/^\/\//, "https://");

                    // get the post ready for queueing up
                    conf_posts.push({
                        "title": comment,
                        "type": "rich",
                        "url": url.replace(".", "https://plus.google.com"),
                        "description": "New post",
                        "image": image,
                        "author": author,
                        "color": 5153614,
                        "timestamp": parse_formatted_date(formatted_date)
                    });
                });
                if (conf_posts.length === 0)
                {
                    console.warn("["+ new Date().toISOString() +"] Found no posts in "+ stream);
                }
                else
                {
                    // read the list of known posts
                    // the file should contain at least this: {}
                    let json = JSON.parse(fs.readFileSync("known_posts.json"));

                    if (!json[community]) json[community] = [];

                    let q = queue((post, callback) => {
                        console.log(colors.cyan("["+ new Date().toISOString() +"] Sending " + post.title + "..."));
                        webhook(post);
                        setTimeout(() => callback(), 1000);
                    }, 1);

                    conf_posts.forEach(post => {
                        // queue the post if it's new, then add it to the list of known posts
                        if (!json[community].find(known_post => { return post.url === known_post.url; }))
                        {
                            console.log(colors.cyan("["+ new Date().toISOString() +"] Found a new post: " + post.title));
                            json[community].push(post);
                            q.push(post, err => {
                                console.log(colors.cyan("["+ new Date().toISOString() +"] Sent " + post.title));
                            });
                        }
                    });

                    if (q.length() === 0)
                    {
                        console.log(colors.magenta("["+ new Date().toISOString() +"] No new posts found"));
                    }

                    // write the list of known posts to a file
                    fs.writeFileSync("known_posts.json", JSON.stringify(json));
                }
            }
            else
            {
                console.error("["+ new Date().toISOString() +"] Received a status code of "+ res.statusCode);
            }
        }
        else
        {
            console.error("["+ new Date().toISOString() +"] "+ err);
        }
    });
}

// Start program execution
console.log(colors.cyan("["+ new Date().toISOString() +"] Checking for new posts..."));
check_for_posts(config.community, config.stream);

// Polls the community stream every 10 seconds
setInterval(() => {
    console.log(colors.cyan("["+ new Date().toISOString() +"] Checking for new posts..."));
    check_for_posts(config.community, config.stream);
}, 5000);
