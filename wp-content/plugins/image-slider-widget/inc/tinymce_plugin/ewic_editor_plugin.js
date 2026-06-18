(function () {

    function ewicIsGutenbergActive() {
        return typeof wp !== 'undefined' && typeof wp.blocks !== 'undefined';
    }

    tinymce.create('tinymce.plugins.ewicicons', {

        init: function (ed, url) {

            var t = this;
            t.url = url;

            if (ewicIsGutenbergActive()) {

                ed.addButton('ewicicons', {
                    id: 'ewicicons_gut_shorcode',
                    classes: 'ewicicons_gut_shorcode_btn',
                    text: 'Image Slider',
                    title: 'Image Slider',
                    cmd: 'mceewicicons_mce',
                    image: url + '/ewic-cp-icon.png'
                });

            }

        },

    });

    tinymce.PluginManager.add('ewicicons', tinymce.plugins.ewicicons);
})();