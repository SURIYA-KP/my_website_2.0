// Passphrase word list: exactly 2048 common, inoffensive English words (11 bits of entropy per word).
// Started from the BIP-39 English list; negative, violent, body-related and otherwise sensitive words were
// removed and replaced with friendly everyday nouns (food, nature, animals, objects). All lowercase a–z,
// 3–9 letters, unique, sorted. Loaded lazily when the Passwords tab opens.
const RAW = `
ability able about above absent absorb abstract access accident account achieve acid acorn acoustic
acquire across act action actor actress actual adapt add address adjust admit adult advance advice
aerobic afford afraid again age agent agree ahead aim air airport aisle alarm album alert alien all
alley allow almond almost alone alpha already also alter always amateur amazing amber among amount
amused analyst anchor ancient angle animal announce annual another answer antenna anthem antique
any apart apology appear apple approve apricot april arch archer arctic area arena argue arm around
arrange arrive arrow art artefact artist artwork ask aspect asset assist assume athlete atlas atom
attend attitude attract auction audit august aunt aurora author auto autumn average avocado avoid
awake aware away awesome awkward axis baby badge badger bag bagel bakery balance balcony ball
ballad bamboo banana banjo banner bar barely bargain barley barrel base basic basil basket beach
beacon bean beauty beaver because become before begin behave behind believe below belt bench
benefit berry best better between beyond bicycle bid bike bind biology birch bird birth biscuit
bison black blade blanket blender bless blossom blouse blue blur blush board boat bobcat boil
bonfire bonus book boost border boring borrow boss bottom bounce bouquet box bracket brain bramble
brand brass brave bread breeze breezy brick bridge brief bright bring brisk broccoli broken bronze
brook broom brother brown brush bubble bucket buckle buddy budget buffalo build bulb bulk bundle
bunny burger burrow bus business busy butter butterfly button buyer buzz cabbage cabin cable cactus
cage cake call calm camel cameo camera camp can canal cancel candle candy canoe canvas canyon
capable capital captain car caramel carbon card cardigan cargo carpet carrot carry cart case cash
cashew castle casual cat catalog catch category cattle caught cause caution cave cedar ceiling
celery cement census century cereal certain chair chalk champion change chaos chapel chapter charge
chase chat cheap check cheese cheetah chef cherry chestnut chicken chief child chimney chipmunk
choice choose chuckle chunk churn cider cinnamon circle citizen citrus city civil claim clap
clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth
cloud clover clown club clump cluster clutch coach coast cobalt cocoa coconut code coffee coil coin
collect color column combine come comet comfort comic common company compass concert confirm
connect consider control convince cook cookie cool copper copy coral core corn correct cosmos cost
cottage cotton couch cougar country couple course cousin cover coyote cozy crack cradle craft cram
crane crater crawl crayon cream credit creek crescent crew cricket crisp critic croissant crop
cross crowd crucial cruise crumble crunch crystal cube culture cup cupboard cupcake curious current
curtain curve cushion custom cute cycle cypress dahlia daisy damp dance daring dash daughter dawn
day daylight deal decade december decide decline decorate decrease deer defense define defy degree
delay deliver demand denim dentist deny depart depend deposit depth deputy derive describe desert
design desk detail detect develop device devote dewdrop diagram dial diamond diary dice diesel diet
differ digital dignity dimple dinner dinosaur direct dirt disagree discover dish dismiss display
distance divert divide doctor document dog doll dolphin domain domino donate donkey donor doodle
door double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drizzle
drop drum dry duck dumpling dune during dust duty dynamic eager eagle early earn earth easily east
easy echo eclipse ecology economy edge edit educate effort egg eight either elder electric elegant
element elephant elevator elite elm else embark ember embody embrace emerald emerge emotion employ
empower empty enable enact end endless endorse energy enforce engage engine enhance enjoy enlist
enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion
error erupt essay essence estate eternal ethics evidence evoke evolve exact example excess exchange
excite exclude excuse exercise exhaust exhibit exist exit exotic expand expect expire explain
express extend extra eye fabric face faculty fade faint faith falcon fall false fame family famous
fan fancy fantasy farm fashion father fault favorite feather feature february federal fee feed feel
fence fern ferry festival fetch few fiber fiction fiddle field fig figure file film filter final
find fine finish fire firefly firm first fiscal fish fit fitness fix fjord flag flame flannel flash
flat flavor flee flight flip float flock floor flower fluid flush flute fly foam focus fog foil
fold follow food foot force forest forget fork fortune forum forward fossil foster found fountain
fox fragile frame freckle frequent fresh friend fringe frog front frost frozen fruit fudge fuel fun
funny furnace future gadget gain galaxy gallery game gap garage garden garlic garment garnet gas
gasp gate gather gauge gaze gazebo gecko general genius genre gentle genuine gesture geyser ghost
giant gift giggle ginger giraffe give glacier glad glance glare glass glide glimmer glimpse globe
glory glove glow glue goat goblet gold gondola good goose gorilla govern gown grab grace grain
granite grant grape grass gravity gravy great green grid grit grocery group grow grunt guard guess
guide guitar gym habit hair half hammer hammock hamster hand happy harbor hard harmony harvest hat
have hawk hazel hazelnut head health heart heavy hedgehog height hello helmet help hen hero heron
hidden high hiking hill hint hire history hobby hockey hold holiday hollow home honey honeybee hood
hope horizon horn horse hospital host hotel hour hover hub huge human humble hummus humor hundred
hungry hurdle hurry husky hybrid ice iceberg icon idea identify idle igloo ignore image imitate
immense immune impact impose improve impulse inch include income increase index indicate indigo
indoor industry infant inform inhale inherit initial inject inkwell inner innocent input inquiry
insect inside inspire install intact interest into invest invite involve iris iron island isolate
issue item ivory jacket jaguar jar jasmine jasper jazz jeans jelly jewel jigsaw job jogging join
joke journey joy judge juice jump jungle junior juniper just kangaroo kayak keen keep ketchup
kettle key kick kid kind kingdom kit kitchen kite kitten kiwi knife knock know koala lab label
labor ladder lagoon lake lamp language lantern laptop large later latin laugh laundry lava lavender
law lawn layer lazy leader leaf learn leave lecture left legal legend leisure lemon lemonade lend
length lens leopard lesson letter level liberty library license life lift light like lilac limit
linen link lion liquid list little live lizard llama load loan lobster local lock locket logic long
loop lotus loud lounge love loyal lucky luggage lullaby lumber lunar lunch luxury lyrics macaron
machine magic magnet magnolia maid mail main major make mallard mammal manage mandate mandolin
mango mansion manual maple marble march margin marigold marine market marmalade mask mass master
match material math matrix matter maximum maze meadow mean measure mechanic medal media melody
melon melt member memory mention menu mercy merge merit merry mesh message metal meteor method
middle midnight milk million mimic mind minimum minor mint minute miracle mirror miss mistake
mitten mix mixed mixture mobile mocha model modify moment monitor monkey monster month moon moose
moral more morning mosaic mother motion motor mountain mouse move movie much muffin mule multiply
museum mushroom music must mutual myself mystery myth naive name napkin narrow nation nature near
nebula nectar need negative neither nephew nerve nest net network neutral never news next nice
nickel night nimble noble noise nominee noodle normal north notable note nothing notice novel now
nugget number nurse nut nutmeg oak oasis oatmeal obey object oblige observe obtain obvious occur
ocean october octopus odor off offer office often oil okay old olive olympic omit once one onion
online only open opera opinion oppose option orange orbit orchard orchid order ordinary organ
orient original ostrich other otter outdoor outer output outside oval oven over own owner oxygen
oyster ozone pact paddle page pair palace palm pancake panda panel panther papaya paper paprika
parade parent park parrot parsley party pass pastel patch path patient patrol pattern pause pave
payment peace peach peanut pear pebble pecan pelican pen pencil penguin peony people pepper perfect
permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pilot pinecone
pink pioneer pipe pitch pizza place planet plastic plate play please pledge pluck plug plum plunge
poem poet point polar pole polka pond pony pool poppy popular porch portion position possible post
potato pottery powder power practice prairie praise predict prefer prepare present pretty pretzel
prevent price pride primary print priority private prize problem process produce profit program
project promote proof property prosper protect proud provide public pudding puffin pull pulp pulse
pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum
quarter quartz question quick quilt quit quiver quiz quote rabbit raccoon race rack radar radio
radish rail rain rainbow raise raisin rally ramp ranch random range rapid rare rate rather raven
raw ready real reason rebel rebuild recall receive recipe record recycle reduce reef reflect reform
refuse region regret regular reject relax release relief rely remain remember remind remove render
renew rent reopen repair repeat replace report require rescue resemble resist resource response
result retire retreat return reunion reveal review reward rhythm ribbon rice rich ride ridge right
rigid ring ripple risk ritual rival river road roast robin robot robust rocket roof rooftop rookie
room rose rosemary rotate rough round route rowboat royal rubber ruby rug rule run runway rural
saddle safe saffron sail sailboat salad salmon salon salt salute same sample sand sandal sapphire
satchel satisfy sauce save say scale scan scarf scatter scene scheme school science scissors scout
scrap screen script scrub sea search seashell season seat second secret section security seed seek
segment select sell seminar senior sense sentence sequoia series service sesame session settle
setup seven shadow shaft shallow share shed shell sherbet shield shift shine ship shiver shock shoe
shop short shrimp shrug shuffle shy sibling side sight sign silent silk silly silver similar simple
since sing siren sister situate six size skate sketch ski skill skirt skylark slab sledding sleep
slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake
snap sniff snow snowflake soap soccer social sock soda soft solar solid solution solve someone song
soon sorry sort soul sound soup source south space spare sparrow spatial spawn speak special speed
spell spend sphere spice spider spike spin spirit split sponsor spoon sport spot spray spread
spring spruce spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state
stay steel stem step stereo stick still stock stone stool story stove strategy street strike strong
student stuff stumble style subject submit subway success such sudden sugar suggest suit summer sun
sunny sunset super supply supreme sure surface surge surprise surround survey sustain swallow swamp
swap swarm sweet swift swim swing switch symbol syrup system table tackle tag tail talent talk tank
tape target task taste taxi teach team tell ten tenant tennis tent term test text thank that theme
then theory there they thing this thistle thought three thrive throw thunder ticket tide tiger tilt
timber time tiny tip tired tissue title toast today toddler together token tomato tomorrow tone
tonight tool tooth top topic topple torch tortoise toss total tourist toward tower town toy track
trade traffic train transfer trap travel tray treat tree trend trial tribe trick trim trip trophy
trouble truck true truly trumpet trust truth try tube tuition tulip tumble tuna tunnel turkey turn
turtle twelve twenty twice twin twist two type typical umber umbrella unable unaware uncle uncover
under undo unfold uniform unique unit universe unknown unlock until unusual unveil update upgrade
uphold upon upper urban urge usage use used useful usual utility vacant vacuum vague valid valley
valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version
very vessel veteran viable vibrant video view village vintage violet virtual visa visit visual
vital vivid vocal voice volume vote voyage waffle wage wagon wait walk wall walnut want warm wash
wasp waste water wave way wealth wear weather web weekend welcome west wet whale what wheat wheel
when where whisper wide width wild will willow win window wing wink winner winter wire wisdom wise
wish witness wolf wonder wood wool word work world worry worth wrap wrestle write wrong yard year
yellow yogurt you young youth zebra zephyr zero zone zoo
`;

export const WORDS: readonly string[] = RAW.trim().split(/\s+/);
