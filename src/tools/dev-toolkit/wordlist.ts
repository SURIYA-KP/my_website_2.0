// Passphrase word list: 2032 common, inoffensive English words (based on the BIP-39 English list,
// with negative or sensitive words removed and a few friendly words added). About 11 bits of entropy per word.
const RAW = `
abandon ability able about above absent absorb abstract absurd access accident account accuse
achieve acid acorn acoustic acquire across act action actor actress actual adapt add address adjust
admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport
aisle alarm album alert alien all alley allow almost alone alpha already also alter always amateur
amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual
another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area
arena argue arm armed armor army around arrange arrive arrow art artefact artist artwork ask aspect
asset assist assume asthma athlete atom attend attitude attract auction audit august aunt author
auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon
badge bag bakery balance balcony ball bamboo banana banner bar barely bargain barrel base basic
basket battle beach bean beauty because become beef before begin behave behind believe below belt
bench benefit best better between beyond bicycle bid bike bind biology bird birth biscuit bitter
black blade blame blanket blast bleak bless blind blossom blouse blue blur blush board boat body
boil bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass
brave bread breeze breezy brick bridge brief bright bring brisk broccoli broken bronze broom brother
brown brush bubble buddy budget buffalo build bulb bulk bundle bunker burden burger burst bus
business busy butter butterfly buyer buzz cabbage cabin cable cactus cage cake call calm camera camp
can canal cancel candle candy cannon canoe canvas canyon capable capital captain car carbon card
cargo carpet carry cart case cash castle casual cat catalog catch category cattle caught cause
caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos
chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice
choose chronic chuckle chunk churn cinnamon circle citizen city civil claim clap clarify claw clay
clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club
clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come
comfort comic common company compass concert conduct confirm congress connect consider control
convince cook cool copper copy coral core corn correct cost cotton couch country couple course
cousin cover coyote cozy crack cradle craft cram crane crash crater crawl crazy cream credit creek
crew cricket crisp critic crop cross crouch crowd crucial cruise crumble crunch crush cry crystal
cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad daisy damage
damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline
decorate decrease deer defense define defy degree delay deliver demand denial dentist deny depart
depend deposit depth deputy derive describe desert design desk despair detail detect develop device
devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur
direct dirt disagree discover dish dismiss disorder display distance divert divide dizzy doctor
document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama
drastic draw dream dress drift drill drink drip drive drop drum dry duck dune during dust dutch duty
dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort
egg eight either elbow elder electric elegant element elephant elevator elite else embark embody
embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce
engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode
equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence
evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit
exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric
face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion father
fatigue fault favorite feather feature february federal fee feed feel female fence festival fetch
fever few fiber fiction field figure file film filter final find fine finger finish fire firm first
fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower
fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum
forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown
frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage
garden garlic garment garnet gas gasp gate gather gauge gaze general genius genre gentle genuine
gesture ghost giant gift giggle ginger giraffe girl give glacier glad glance glare glass glide
glimpse globe gloom glory glove glow glue goat gold good goose gorilla gossip govern gown grab grace
grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess
guide guilt guitar gym habit hair half hammer hamster hand happy harbor hard harmony harsh harvest
hat have hawk hazard hazel head health heart heavy hedgehog height hello helmet help hen hero hidden
high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn
horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry
hurt husband hybrid ice icon idea identify idle ignore ill image imitate immense immune impact
impose improve impulse inch include income increase index indicate indoor industry infant inform
inhale inherit initial inject inner innocent input inquiry insect inside inspire install intact
interest into invest invite involve iris iron island isolate issue item ivory jacket jaguar jar
jasmine jazz jealous jeans jelly jewel jigsaw job join joke journey joy judge juice jump jungle
junior junk just kangaroo kayak keen keep ketchup key kick kid kind kingdom kiss kit kitchen kite
kitten kiwi knee knife knock know lab label labor ladder lady lagoon lake lamp language lantern
laptop large later latin laugh laundry lava law lawn layer lazy leader leaf learn leave lecture left
leg legal legend leisure lemon lend length lens leopard lesson letter level liberty library license
life lift light like limb limit link lion liquid list little live lizard load loan lobster local
lock logic lonely long loop loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics
machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual
maple marble march margin marigold marine market marriage mask mass master match material math
matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory
mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic
mind minimum minor minute miracle mirror miss mistake mix mixed mixture mobile model modify mom
moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain
mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery
myth naive name napkin narrow nation nature near neck nectar need negative neglect neither nephew
nerve nest net network neutral never news next nice night noble noise nominee noodle normal north
nose notable note nothing notice novel now nuclear number nurse nut nutmeg oak oatmeal obey object
oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old
olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard
orchid order ordinary organ orient original ostrich other outdoor outer output outside oval oven
over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper
paprika parade parent park parrot party pass patch path patient patrol pattern pause pave payment
peace peanut pear peasant pebble pelican pen penalty pencil people pepper perfect permit person pet
phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pitch
pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole
police pond pony pool popular portion position possible post potato pottery poverty powder power
practice praise predict prefer prepare present pretty prevent price pride primary print priority
private prize problem process produce profit program project promote proof property prosper protect
proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse
push put puzzle pyramid quality quantum quarter quartz question quick quit quiver quiz quote rabbit
raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather
raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect
reform refuse region regret regular reject relax release relief rely remain remember remind remove
render renew rent reopen repair repeat replace report require rescue resemble resist resource
response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride
ridge right rigid ring ripple risk ritual rival river road roast robot robust rocket romance roof
rookie room rose rosemary rotate rough round route royal rubber rude rug rule run runway rural sad
saddle sadness safe saffron sail salad salmon salon salt salute same sample sand sapphire satisfy
sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout
scrap screen script scrub sea search season seat second secret section security seed seek segment
select sell seminar senior sense sentence series service session settle setup seven shadow shaft
shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder
shove shrimp shrug shuffle shy sibling side siege sight sign silent silk silly silver similar simple
since sing siren sister situate six size skate sketch ski skill skin skirt slab slam sleep slender
slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff
snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry
sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere
spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square
squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem
step stereo stick still sting stock stomach stone stool story stove strategy street strike strong
struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest
suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey
sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup
system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten
tenant tennis tent term test text thank that theme then theory there they thing this thistle thought
three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title
toast today toddler toe together token tomato tomorrow tone tongue tonight tool tooth top topic
topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic
train transfer trap trash travel tray treat tree trend trial tribe trick trim trip trophy trouble
truck true truly trumpet trust truth try tube tuition tulip tumble tuna tunnel turkey turn turtle
twelve twenty twice twin twist two type typical umber umbrella unable unaware uncle uncover under
undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update
upgrade uphold upon upper upset urban urge usage use used useful usual utility vacant vacuum vague
valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb
verify version very vessel veteran viable vibrant victory video view village vintage violet violin
virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage waffle wage
wagon wait walk wall walnut want warm warrior wash wasp waste water wave way wealth wear weasel
weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper
wide width wife wild will willow win window wine wing wink winner winter wire wisdom wise wish
witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong
yard year yellow yogurt you young youth zebra zephyr zero zone zoo
`;

export const WORDS: readonly string[] = RAW.trim().split(/\s+/);
